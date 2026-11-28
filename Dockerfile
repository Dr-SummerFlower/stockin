# syntax=docker/dockerfile:1
#
# 进货统计应用 —— OpenCloudOS 9 minimal 生产镜像（2026-11-15）
#
# 设计要点：
#  1. 基础镜像 opencloudos/opencloudos9-minimal（RPM 系，自带国内 dnf 源）。
#     镜像内没有 Node/npm：先由 dnf 装 nodejs20 + npm 作为**引导**，
#     再用 npm 装 pnpm，最后由 `pnpm runtime set node 26.13.0 -g` 安装项目锁定的
#     Node。它落在 $PNPM_HOME/bin 且 PATH 优先，bootstrap.ts 的
#     assertNodeVersion() 会再精确断言一次，双重保险。
#  2. 默认值固定走国内源（部署服务器在国内），同时保留可选 ARG 供 CI 覆盖：
#       GitHub Actions runner 在境外，构建时应把 NPM_REGISTRY 与
#       NODE_DOWNLOAD_MIRROR 覆盖回官方源（见 .github/workflows/release.yml）。
#     dnf 仍用镜像自带的 OpenCloudOS.repo / epol.repo。
#  3. `libatomic` 是 pnpm 安装的 Node 26 二进制的硬依赖（缺 libatomic.so.1 起不来）。
#  4. pnpm 的 node shim 目标文件默认 600 root-only，非 root (10001) 执行会报
#     "cannot read the global target of the node shim" → 显式放开 /opt/pnpm/bin 读权限。
#  5. 后端是单文件 CJS bundle，runtime 只需 server/dist + web/dist，零 node_modules。
#  6. HEALTHCHECK 打纯内存 /api/health；CMD exec 形式 + STOPSIGNAL SIGTERM。

# -------- 可选构建参数：默认值即国内生产环境，CI 可按需覆盖 --------
ARG BASE_IMAGE=opencloudos/opencloudos9-minimal
ARG PNPM_VERSION=12.15.0
ARG NODE_VERSION=26.13.0
ARG NPM_REGISTRY=https://registry.npmmirror.com/
ARG NODE_DOWNLOAD_MIRROR=https://npmmirror.com/mirrors/node/

# ---------------------------------------------------------------- base ----
FROM ${BASE_IMAGE} AS base
ARG PNPM_VERSION
ARG NODE_VERSION
ARG NPM_REGISTRY
ARG NODE_DOWNLOAD_MIRROR
ENV TZ=Asia/Shanghai \
    NODE_ENV=production \
    PNPM_HOME=/opt/pnpm \
    PATH=/opt/pnpm/bin:$PATH
# 引导工具链 + 运行时依赖。libatomic 必须在列，否则 pnpm 装的 Node 26 无法启动。
RUN dnf install -y --setopt=install_weak_deps=False \
      nodejs npm tzdata ca-certificates libatomic curl tar gzip \
 && dnf clean all
# pnpm 的 nodeDownloadMirrors 是 Record，只能写成 YAML 映射，不能传 JSON 字符串。
# 传空 NODE_DOWNLOAD_MIRROR 即跳过该配置，回落到 pnpm 官方源。
RUN npm install -g pnpm@${PNPM_VERSION} --registry=${NPM_REGISTRY} \
 && if [ -n "${NODE_DOWNLOAD_MIRROR}" ]; then \
      mkdir -p "${HOME}/.config/pnpm"; \
      printf 'nodeDownloadMirrors:\n  release: %s\n' "${NODE_DOWNLOAD_MIRROR}" \
        > "${HOME}/.config/pnpm/config.yaml"; \
    fi \
 && pnpm runtime set node ${NODE_VERSION} -g \
 && test "$(node --version)" = "v${NODE_VERSION}" \
 && chmod -R a+rX /opt/pnpm/bin \
 && echo "[base] pnpm $(pnpm --version) / node $(node --version)"
WORKDIR /app

# ---------------------------------------------------------------- deps ----
FROM base AS deps
ARG NPM_REGISTRY
# 仅 COPY 清单文件：依赖不变时该层可缓存，源码变化不触发重装。
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc tsconfig.base.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/domain/package.json packages/domain/package.json
RUN pnpm install --frozen-lockfile \
      --registry=${NPM_REGISTRY} \
      --store-dir /app/.pnpm-store

# --------------------------------------------------------------- build ----
FROM base AS build
# 先接住 deps 的 node_modules + CAS，再叠加快照源码。
COPY --from=deps /app/ /app/
COPY . .
RUN pnpm -r build \
 && test -f apps/server/dist/index.js \
 && test -f apps/server/dist/repositories/migrations/001_init.sql \
 && test -f apps/web/dist/index.html \
 && echo '[smoke] 构建产物齐全'

# ------------------------------------------------------------- runtime ----
FROM base AS runtime
ARG NODE_VERSION
# 来源白名单基线：至少保证本机回环访问不会触发「请求来源校验失败」。
# 部署时由 compose 的 PUBLIC_ORIGINS 覆盖为实际的 IP / 域名列表。
ENV PORT=8080 \
    COOKIE_SECURE=false \
    DATA_DIR=/app/data \
    BACKUP_DIR=/app/backups \
    TMP_DIR=/app/tmp \
    WEB_DIST_DIR=/app/apps/web/dist \
    PUBLIC_ORIGINS=http://localhost:8080,http://127.0.0.1:8080
COPY --from=build /app/apps/server/dist/ /app/apps/server/dist/
COPY --from=build /app/apps/web/dist/ /app/apps/web/dist/
RUN mkdir -p /app/data /app/backups /app/tmp \
 && chown -R 10001:10001 /app/data /app/backups /app/tmp
RUN test "$(node --version)" = "v${NODE_VERSION}" \
 && node -e "const s=require('node:sqlite');if(typeof s.DatabaseSync!=='function')process.exit(1);console.log('[smoke] node:sqlite OK')"
USER 10001
EXPOSE 8080
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('node:http').get('http://127.0.0.1:'+(process.env.PORT||'8080')+'/api/health',r=>{r.resume();process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))"
CMD ["node", "apps/server/dist/index.js"]
