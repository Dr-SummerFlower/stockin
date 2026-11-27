#!/usr/bin/env node
/**
 * 生成多平台「解压即用」制品的 staging 目录（**不做压缩**，压缩交给 CI）。
 *
 * 用法：node scripts/package-artifacts.mjs <version> [imageTag] [imageRepo]
 *   version   —— Release 版本，如 1.0.0 或 pre-a1b2c3d
 *   imageTag  —— GHCR 镜像标签，缺省与 version 相同
 *   imageRepo —— 镜像仓库（不含标签），缺省取环境变量 IMAGE_REPO，
 *                再缺省 `ghcr.io/dr-summerflower/stockin`。CI 传入按
 *                `repository_owner` 推导出的实际仓库，避免 compose 里写死
 *                某个账号（发布审查 P3）。
 *
 * 产出目录：.tmp/artifacts/<platform>/stockin/
 *   win-x64   : server/dist + web/dist + start.bat + README.md
 *   linux-x64 : server/dist + web/dist + start.sh  + README.md
 *   docker    : docker-compose.yml + .env + README.md（无需源码，直接拉取 GHCR 镜像）
 *   workers   : dist/worker.mjs + wrangler.toml + README.md（**产物存在时才生成**）
 *
 * 设计约束：
 *  - win / linux 包不含运行时：Node.js 26.13.0 由使用者自行安装，启动脚本精确校验。
 *  - 后端是单文件 CJS bundle，所有依赖已内联，压缩包里没有 node_modules。
 *  - win / linux 包**不含** `worker.mjs`（那是 Workers 产物，2.4MB 白占体积）。
 *  - DATA_DIR / BACKUP_DIR / TMP_DIR 一律用绝对路径且落在包目录内，
 *    绝不落进 web/dist 静态托管根（env.ts 与 static.ts 有双重守卫）。
 *  - WEB_DIST_DIR 显式给绝对路径，避免依赖 defaultStaticRoot() 的 __filename 反推。
 */
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const outRoot = join(root, '.tmp', 'artifacts');
const version = process.argv[2] ?? process.env.RELEASE_VERSION ?? 'dev';
const imageTag = process.argv[3] ?? process.env.IMAGE_TAG ?? version;
const imageRepo = process.argv[4] ?? process.env.IMAGE_REPO ?? 'ghcr.io/dr-summerflower/stockin';

const serverDist = join(root, 'apps', 'server', 'dist');
const webDist = join(root, 'apps', 'web', 'dist');

const REQUIRED = [
  [serverDist, 'index.js'],
  [serverDist, join('repositories', 'migrations', '001_init.sql')],
  [webDist, 'index.html'],
];

for (const [dir, rel] of REQUIRED) {
  if (!existsSync(join(dir, rel))) {
    process.stderr.write(`[package] 缺少构建产物 ${join(dir, rel)}；请先执行 pnpm build\n`);
    process.exit(1);
  }
}

rmSync(outRoot, { recursive: true, force: true });
mkdirSync(outRoot, { recursive: true });

function put(base, rel, content, mode) {
  const target = join(base, rel);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf8');
  if (mode !== undefined) {
    chmodSync(target, mode);
  }
}

function stage(platform, build) {
  const dir = join(outRoot, platform, 'stockin');
  mkdirSync(dir, { recursive: true });
  build(dir);
  process.stdout.write(`[package] ${platform} -> ${dir}\n`);
}

/** win / linux 共用的运行时文件。 */
function copyRuntime(dir) {
  // 只排除 Worker 产物：`worker.mjs`（约 2.4MB）是给 Cloudflare 用的，
  // 塞进 win/linux 包纯属白占体积（发布审查 P2-4）。
  // 用「过滤」而不是「白名单 cp 单个文件」：后端将来多出任何 dist 资源
  // （新的迁移 SQL、模板等）都会被自动带上，不会因为漏配而缺文件。
  cpSync(serverDist, join(dir, 'server', 'dist'), {
    recursive: true,
    filter: (src) => basename(src) !== 'worker.mjs',
  });
  cpSync(webDist, join(dir, 'web', 'dist'), { recursive: true });
}

const COMMON_README = `## 运行时

本压缩包**不含 Node.js**。请先自行安装 **Node.js 26.13.0**，应用启动时会精确校验版本，
版本不符会直接报错退出。后端已是单文件程序，所有依赖已打包在内，无需 npm install。

## 首次使用

1. 首次启动会在控制台打印 \`[BOOTSTRAP] username=admin password=xxxx\`，
   这是初始账号与一次性随机密码。
2. 浏览器打开 http://127.0.0.1:8080，用该账号登录后按引导修改密码。
3. 卷保留、重启时不会重新生成或再次打印初始密码。

## 局域网访问

编辑启动脚本里的 \`PUBLIC_ORIGIN\`，改成 \`http://<本机IP>:8080\`。
端口必须和 \`PORT\`（8080）保持一致，否则写操作会被 CSRF 校验拒绝。

## 数据位置

\`data/\` 是数据库，\`backups/\` 是每日快照，\`tmp/\` 是临时目录，三者会在首次启动时自动创建。
**升级时只替换 \`server/\` 与 \`web/\` 两个目录，不要删除这三个目录。**

## 升级与回滚

解压新版本到新目录，把旧目录的 \`data/\` 与 \`backups/\` 复制过去即可；
回滚同理，用旧版程序目录配同一份数据目录。若新版已执行过数据库迁移，
旧版程序可能因 \`user_version\` 不匹配而拒绝启动，此时需要先在应用内确认回滚放行。
`;

const START_BAT = `@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 Node.js，请先安装 Node.js 26.13.0 后重新运行。
  exit /b 1
)
for /f "delims=" %%v in ('node --version') do set "NODEVER=%%v"
if not "%NODEVER%"=="v26.13.0" (
  echo [错误] 需要 Node.js v26.13.0，当前为 %NODEVER%。
  exit /b 1
)

REM 局域网访问时，把下一行改成 http://<本机IP>:8080
set "PUBLIC_ORIGIN=http://127.0.0.1:8080"
set "PORT=8080"
set "TZ=Asia/Shanghai"
set "NODE_ENV=production"
set "DATA_DIR=%~dp0data"
set "BACKUP_DIR=%~dp0backups"
set "TMP_DIR=%~dp0tmp"
set "WEB_DIST_DIR=%~dp0web\\dist"
REM 逻辑备份默认公钥（可选）：仅首次启动、库内无公钥时播种一条；之后在管理台维护。
if not defined BACKUP_PUBLIC_KEY set "BACKUP_PUBLIC_KEY="

echo 正在启动进货统计，访问 %PUBLIC_ORIGIN%
echo 首次启动会在下方打印 [BOOTSTRAP] 初始账号与密码，请及时登录并修改。
node "server\\dist\\index.js"
`.replace(/\n/g, '\r\n');

const START_SH = `#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "[错误] 未找到 Node.js，请先安装 Node.js 26.13.0 后重新运行。" >&2
  exit 1
fi
actual="$(node --version)"
if [ "$actual" != "v26.13.0" ]; then
  echo "[错误] 需要 Node.js v26.13.0，当前为 $actual。" >&2
  exit 1
fi

# 局域网访问时，把下一行改成 http://<本机IP>:8080
export PUBLIC_ORIGIN="\${PUBLIC_ORIGIN:-http://127.0.0.1:8080}"
export PORT=8080
export TZ=Asia/Shanghai
export NODE_ENV=production
export DATA_DIR="$PWD/data"
export BACKUP_DIR="$PWD/backups"
export TMP_DIR="$PWD/tmp"
export WEB_DIST_DIR="$PWD/web/dist"
# 逻辑备份默认公钥（可选）：仅首次启动、库内无公钥时播种一条；之后在管理台维护。
export BACKUP_PUBLIC_KEY="\${BACKUP_PUBLIC_KEY:-}"

echo "正在启动进货统计，访问 $PUBLIC_ORIGIN"
echo "首次启动会在下方打印 [BOOTSTRAP] 初始账号与密码，请及时登录并修改。"
exec node server/dist/index.js
`;

stage('win-x64', (dir) => {
  copyRuntime(dir);
  put(dir, 'start.bat', START_BAT);
  put(dir, 'README.md', `# 进货统计 · Windows x64（${version}）\n\n双击 \`start.bat\` 启动，或命令行运行。\n\n${COMMON_README}`);
});

stage('linux-x64', (dir) => {
  copyRuntime(dir);
  put(dir, 'start.sh', START_SH, 0o755);
  put(dir, 'README.md', `# 进货统计 · Linux x64（${version}）\n\n\`./start.sh\` 启动（可用 systemd / supervisor 托管）。\n\n${COMMON_README}`);
});

stage('docker', (dir) => {
  const compose = readFileSync(join(root, 'docker-compose.yml'), 'utf8');
  put(dir, 'docker-compose.yml', compose);
  put(
    dir,
    'start.sh',
    readFileSync(join(root, 'scripts', 'templates', 'docker-start.sh'), 'utf8'),
    0o755,
  );
  put(
    dir,
    'start.bat',
    readFileSync(join(root, 'scripts', 'templates', 'docker-start.bat'), 'utf8').replace(
      /\n/g,
      '\r\n',
    ),
  );
  put(
    dir,
    '.env',
    `# 发布版本 ${version}\n` +
      `# 镜像来自 GHCR，升级与回滚只改 IMAGE_TAG 后重新 docker compose up -d\n` +
      `# IMAGE_REPO 由 CI 按仓库归属自动写入，换账号 / fork 时无需改 docker-compose.yml。\n` +
      `IMAGE_REPO=${imageRepo}\n` +
      `IMAGE_TAG=${imageTag}\n\n` +
      `# 来源白名单基线。start.sh / start.bat 会自动探测本机 IP 并临时覆盖这一行；\n` +
      `# 直接执行 docker compose up -d 时则以本行为准。\n` +
      `PUBLIC_ORIGINS=http://127.0.0.1:8080,http://localhost:8080\n\n` +
      `# 有域名或其它固定 IP 时写在这里，启动脚本会自动追加到白名单。\n` +
      `# EXTRA_ORIGINS=http://stockin.example.com:8080\n\n` +
      `HOST_PORT=8080\n`,
  );
  put(
    dir,
    'README.md',
    `# 进货统计 · Docker（${version}）\n\n` +
      `## 快速启动\n\n` +
      `- Linux / macOS：\`./start.sh\`\n` +
      `- Windows：\`start.bat\`\n\n` +
      `启动脚本会**自动探测本机所有 IP 并生成来源白名单**，然后 \`docker compose up -d\`。\n` +
      `不需要源码、不需要 \`--build\`、不需要宿主机装 Node.js。\n` +
      `也可以直接 \`docker compose up -d\`，此时使用 \`.env\` 里的 \`PUBLIC_ORIGINS\`。\n\n` +
      `镜像仓库与版本由 \`.env\` 的 \`IMAGE_REPO\` / \`IMAGE_TAG\` 决定，换账号或 fork 后只改这两行。\n\n` +
      `## 来源白名单（防「请求来源校验失败」）\n\n` +
      `应用会逐一比对浏览器 Host / Origin / Referer 与可信来源集合。\n` +
      `**任何会用来访问的地址都必须出现在 \`PUBLIC_ORIGINS\` 里**，否则登录和写数据返回 403 \`AUTH_CSRF_FAILED\`。\n\n` +
      `- 格式：\`http://<IP或域名>:<宿主端口>\`，逗号分隔；端口必须与 \`HOST_PORT\` 一致。\n` +
      `- 回环写法（127.0.0.1 / localhost / [::1]）会自动等价展开。\n` +
      `- 有域名或多网卡时，把地址写进 \`.env\` 的 \`EXTRA_ORIGINS\`，启动脚本会自动追加。\n` +
      `- 镜像内已预置回环基线，因此即使忘配，本机访问也不会 403；局域网访问必须靠脚本探测或手工填写。\n\n` +
      `首次启动用 \`docker compose logs -f stockin\` 查看 \`[BOOTSTRAP]\` 初始密码。\n\n` +
      `## 升级与回滚\n\n` +
      `改 \`.env\` 的 \`IMAGE_TAG\` 到目标版本，再 \`docker compose up -d\`；回滚改回上一版即可。\n` +
      `数据库与备份在命名卷 \`stockin-data\` / \`stockin-backups\`，**不要执行 \`docker compose down -v\`**。\n` +
      `若新版已执行过数据库迁移，旧镜像可能因 \`user_version\` 不匹配而拒绝启动，需先确认回滚放行。\n`,
  );
});

// Workers 包只在 Worker 产物与 wrangler 配置都存在时才生成，避免打出不可用的空包。
//
// **目录必须与 wrangler.toml 里的相对路径逐字一致**（`main` 指向
// `apps/server/dist/worker.mjs`，`[assets].directory` 指向 `./apps/web/dist`）。
// 早期版本把产物摊平成 `dist/` + `web/dist/`，解压后 `wrangler deploy` 找不到
// 入口文件直接报错，所以这里保留仓库原布局，做到「解压即可 deploy」。
const workerBundle = join(root, 'apps', 'server', 'dist', 'worker.mjs');
const wranglerConfig = join(root, 'wrangler.toml');
if (existsSync(workerBundle) && existsSync(wranglerConfig)) {
  stage('workers', (dir) => {
    cpSync(workerBundle, join(dir, 'apps', 'server', 'dist', 'worker.mjs'));
    cpSync(webDist, join(dir, 'apps', 'web', 'dist'), { recursive: true });
    cpSync(wranglerConfig, join(dir, 'wrangler.toml'));
    put(
      dir,
      'README.md',
      `# 进货统计 · Cloudflare Workers（${version}）\n\n` +
        `产物已按仓库原布局放置，与 \`wrangler.toml\` 内的路径一致，**解压后可直接部署**。\n\n` +
        `## 快速部署\n\n` +
        '```\nnpx wrangler login\nnpx wrangler deploy\n```\n\n' +
        `首次部署会自动创建 Durable Object（迁移 \`v1\`，\`new_sqlite_classes\`），无需手工建库。\n\n` +
        `## 部署前必改：来源白名单\n\n` +
        `\`wrangler.toml\` 的 \`[vars].PUBLIC_ORIGINS\` 默认是占位域名，**必须换成实际访问地址**，\n` +
        `否则登录与任何写操作都会返回 403 \`AUTH_CSRF_FAILED\`（「请求来源校验失败」）。\n\n` +
        '- 格式：`https://<域名>`，无端口；可写多个，逗号分隔。\n' +
        '- 包含 `https://<worker名>.<账户子域>.workers.dev` 与所有自定义域名。\n' +
        '- 也可不改文件，部署时覆盖：`npx wrangler deploy --var PUBLIC_ORIGINS:https://a,https://b`。\n\n' +
        `## 首次使用\n\n` +
        `首次部署后执行 \`npx wrangler tail\`，日志里会打印 \`[BOOTSTRAP] username=admin password=xxxx\`，\n` +
        `这是初始账号与一次性随机密码。凭据只存在于 Durable Object 存储，不会重复打印。\n\n` +
        `## 运行时与数据\n\n` +
        `运行时由 Cloudflare 提供，无需自备 Node.js。数据存放在 Durable Object 内置 SQLite，\n` +
        `备份依赖平台 PITR / Time Travel，不使用本机文件快照（应用内备份入口会显示由平台托管）。\n\n` +
        `## 升级与回滚\n\n` +
        `升级：重复执行 \`npx wrangler deploy\`。\n` +
        `回滚：\`npx wrangler rollback --name <worker名>\` 回退到上一个版本。\n` +
        `**数据库不随代码回滚**：新版本若已执行过 schema 迁移，回退旧版本会因版本号不匹配而拒绝启动，\n` +
        `需要显式放行回滚（与 Docker / Node 侧口径一致）。\n`,
    );
  });
} else {
  process.stdout.write(
    '[package] 跳过 workers 包：缺少 apps/server/dist/worker.mjs 或 wrangler.toml\n',
  );
}

process.stdout.write(
  `[package] staging 完成，版本 ${version}，镜像 ${imageRepo}:${imageTag}\n`,
);
