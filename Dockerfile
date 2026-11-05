# syntax=docker/dockerfile:1
#
# 进货统计应用 —— 三阶段生产镜像（T05）
#
# 设计要点：
#  1. 三阶段统一 FROM $NODE_IMAGE（ARG 默认值 node:26.13.0-bookworm-slim），
#     与 bootstrap.ts 的 process.versions.node === '26.13.0' 精确断言一致；
#     不引入 Umi 5 / 其它 Node 大版本，不把设计文档旧版 packageManager 抄回来。
#  2. runtime 只含「server 生产依赖（pnpm deploy --prod）+ web/dist」，
#     不携带 umi / antd / react / webpack / @umijs，也不在 runtime 构建前端产物。
#  3. better-sqlite3@13.0.3 为 gypfile:false、无 install 钩子、单包内按 exports
#     分发 prebuilds/linux-x64.node；bookworm(glibc) 直接可 require。
#     build-essential / python3 仅作为「万一需要源码编译」的兜底，不是必要条件。
#  4. tsc 只编译 .ts，不会把 001_init.sql 拷进 dist；build 阶段显式拷入，
#     让 resolveMigrationsDir() 的候选 ②（dist/repositories/migrations）命中，
#     从而不依赖 process.cwd()。deploy 同时会带上 src/，候选 ③ 亦可用。
#  5. CAS 放在 /app/.pnpm-store（deps 与 build 用同一 --store-dir），
#     因三阶段均为独立 FROM，build 通过 COPY --from=deps /app/ 把 node_modules
#     与 CAS 一起带过来，deploy 无需再次联网下载。
#  6. A4 后 createApp 优先取 env.staticRoot，故 runtime 必须显式给 WEB_DIST_DIR；
#     否则 loadEnv 在 cwd=/app 下会把默认 '../web/dist' 解析成 /web/dist。
#  7. data/ backups/ tmp/ 三卷绝不落在静态托管根之下（loadEnv 与 static.ts 双守卫）。
#  8. HEALTHCHECK 用 node -e 请求纯内存 /api/health（不跑 SQL）；
#     CMD 使用 exec 形式，保证 SIGTERM 直达 Node PID 1，配合 stop_grace_period。

ARG NODE_IMAGE=node:26.13.0-bookworm-slim

# ---------------------------------------------------------------- deps ----
FROM $NODE_IMAGE AS deps
ENV TZ=Asia/Shanghai \
    DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends tzdata build-essential python3 ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# 全局 pnpm 在 COPY .npmrc 之前安装，避免项目 .npmrc 的 engine-strict 影响全局安装。
RUN npm install -g pnpm@12 && pnpm --version
WORKDIR /app
# 仅 COPY 清单文件：依赖不变时该层可缓存，源码变化不触发重装。
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc tsconfig.base.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/domain/package.json packages/domain/package.json
# pnpm-workspace.yaml 内 allowBuilds / minimumReleaseAge 随清单一起生效；
# --frozen-lockfile 保证 lock 与清单严格一致；CAS 落在 /app 内以便跨阶段复制。
RUN pnpm install --frozen-lockfile --store-dir /app/.pnpm-store

# --------------------------------------------------------------- build ----
FROM $NODE_IMAGE AS build
ENV TZ=Asia/Shanghai \
    DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends tzdata build-essential python3 ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@12
WORKDIR /app
# 先接住 deps 的 node_modules + CAS（含 .pnpm 虚拟 store 的相对符号链接）。
COPY --from=deps /app/ /app/
# 再叠加快照源码；.dockerignore 排除 **/node_modules/ 与 **/dist/，不会覆盖上一步。
COPY . .
# 拓扑序：shared / domain 先产出 dist 声明，server(tsc) 与 web(umi build) 随后。
RUN pnpm -r build
# tsc 不搬 .sql：把迁移脚本拷进 dist，供 A3 resolveMigrationsDir 候选 ② 命中。
RUN cp apps/server/src/repositories/migrations/*.sql apps/server/dist/repositories/migrations/ \
 && test -f apps/server/dist/repositories/migrations/001_init.sql
# 仅导出 @stockin/server 的生产依赖为自包含目录；不把 umi/antd/react 带进 runtime。
RUN pnpm --filter @stockin/server deploy --prod --store-dir /app/.pnpm-store /app/prod
# 容器内 linux-x64 二进制冒烟（本机 win-x64 无法实测这一条，故放进 builder）。
RUN cd /app/prod \
 && node -e "const D=require('better-sqlite3');const db=new D(':memory:');if(db.prepare('select 1 as x').get().x!==1)process.exit(1);db.close();console.log('[smoke] better-sqlite3 linux-x64 OK')"

# ------------------------------------------------------------- runtime ----
FROM $NODE_IMAGE AS runtime
ENV TZ=Asia/Shanghai \
    DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    PORT=8080 \
    COOKIE_SECURE=false \
    DATA_DIR=/app/data \
    BACKUP_DIR=/app/backups \
    TMP_DIR=/app/tmp \
    WEB_DIST_DIR=/app/apps/web/dist
# runtime 不再需要 build-essential / python3：产物已自带预编译二进制。
RUN apt-get update \
 && apt-get install -y --no-install-recommends tzdata ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# 保持 monorepo 相对布局：static.js 的 '../../web/dist/' 与 WEB_DIST_DIR 同时指向它。
COPY --from=build /app/prod/ /app/apps/server/
COPY --from=build /app/apps/web/dist/ /app/apps/web/dist/
# 三卷由非 root 用户写入；命名卷首次创建会继承镜像内目录属主。
RUN mkdir -p /app/data /app/backups /app/tmp \
 && chown -R 10001:10001 /app/data /app/backups /app/tmp
# 最终镜像树再冒烟一次：验证 COPY 之后的相对符号链接与 .node 二进制均可加载。
RUN cd /app/apps/server \
 && node -e "const D=require('better-sqlite3');const db=new D(':memory:');if(db.prepare('select 1 as x').get().x!==1)process.exit(1);db.close();console.log('[smoke] runtime better-sqlite3 OK')"
USER 10001
EXPOSE 8080
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('node:http').get('http://127.0.0.1:'+(process.env.PORT||'8080')+'/api/health',r=>{r.resume();process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))"
CMD ["node", "apps/server/dist/index.js"]
