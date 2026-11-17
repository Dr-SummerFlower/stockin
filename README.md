# 进货统计

面向个体商家本人的进货流水账工具：在浏览器里逐笔登记进货明细，开屏即看累计经营指标与临期/过期风险，并支持 Excel 模板下载、批量导入与按条件导出。

单账户、单实例、纯 HTTP（默认 `http://IP:8080`）。生产部署目标是 1 核 1G 服务器上的单个 Docker 容器；也提供 Node 裸包与 Cloudflare Workers 产物。

## 功能一览

- **10 字段记录**：商品名称、进货日期、生产日期、保质期、到期日期、规格、单价、数量、金额、备注。
- **两组三选二联动**：日期组（生产日期 / 保质期 / 到期日期）与金额组（单价 / 数量 / 金额）各填任意两项，第三项自动推算；手填值可覆盖自动值，覆盖后不再重算。
- **确定性口径**：单价 4 位、数量 3 位、金额 2 位定点数，金额以分为单位存储，HALF_UP 舍入；到期日 = 生产日期 + N（不减 1），月/年按日历回退并钳制月末。
- **统计大屏**：6 组指标（累计金额、笔数、商品种类、累计数量、临期、过期）＋临期/过期清单；临期阈值单一可配（默认 30 天，0 表示当天到期也计入临期）。
- **Excel 双向**：模板下载、逐行校验与错误行报告、八项判重、按筛选/日期范围导出；整批导入单事务，全有或全无。上限 2MB / 1000 行 / 15 秒。
- **记录维护**：编辑、删除、批量删除、回收站（恢复/彻底删除）、操作日志、条件筛选。
- **会话与备份**：账密登录（scrypt 哈希 + 服务端会话 + HttpOnly Cookie）、登录失败限流、每日/导入前/迁移前自动备份，保留最近 7 份。
- **端适配与主题**：桌面/平板/手机浏览器均可完成全部业务；浅色 / 深色 / 跟随系统三态主题。

明确不做：PWA/离线缓存、HTTPS 与域名、外部告警、多账户与权限、图表下钻、任何大模型能力。

## 快速开始（Docker，推荐）

发布包解压后无需源码与宿主机 Node.js。进入包目录：

```bash
cp .env.example .env          # 编辑 .env：确认镜像标签与来源白名单
./start.sh                    # Linux / macOS；自动探测本机 IP 生成白名单
# 或 start.bat                 # Windows
```

也可直接 `docker compose up -d`，此时使用 `.env` 里的 `PUBLIC_ORIGINS`（不会自动探测 IP）。

首次启动直接打开 `http://127.0.0.1:8080`，页面会进入 `/setup` 自助引导：

1. 设置管理员用户名与密码；
2. 设置密保问题与答案（忘记密码时使用，不区分大小写）；
3. 填写店铺名称、临期阈值与界面主题。

完成后用刚设置的账号登录。**不再生成或打印任何初始密码**，因此日志里不需要找凭据。

> ⚠️ **抢注风险**：初始化完成前，任何能访问到本实例的人都可以完成 `/setup` 成为管理员。
> 公网部署（尤其 Cloudflare Workers）必须在初始化前限制入口访问，例如 Cloudflare Access、
> IP 白名单或临时下线路由；完成初始化后再开放。Node 自托管不要把端口直接暴露公网。

登录后可在「设置 → 账号安全」修改密码或更换密保问题；忘记密码时在登录页点「忘记密码」，
回答密保问题即可重置。修改密码或重置密码都会吊销全部会话，所有设备需重新登录。

### 来源白名单（最容易踩的坑）

应用会逐一比对浏览器 Host / Origin / Referer 与可信来源集合。**任何会用来访问的地址都必须列进 `PUBLIC_ORIGINS`**，否则登录和写操作返回 `403 AUTH_CSRF_FAILED`（页面能打开但写不进去，通常就是这个问题）。

- 格式：`http://<IP或域名>:<端口>`，多个用逗号分隔；不能带路径或结尾斜杠。
- 端口必须与 `HOST_PORT` 一致；容器内固定监听 8080，**不要改 `HOST_PORT` 为非 8080**，否则 Host 与白名单不匹配。
- `127.0.0.1` / `localhost` / `[::1]` 会自动等价展开；局域网 IP 和域名不会，必须逐个列出。`start.sh` / `start.bat` 会自动探测并追加本机 IP；固定域名可写在 `.env` 的 `EXTRA_ORIGINS`。
- 当前为纯 HTTP：来源 scheme 用 `http`，Cookie 不加 `Secure`；改 `ORIGIN_SCHEME=https` 需同步改来源并解决 TLS（本版本不在部署范围内）。

### 升级、回滚与数据位置

- 数据库与备份放在命名卷 `stockin-data` / `stockin-backups`；临时文件在 tmpfs。**不要执行 `docker compose down -v`**，那会删除数据卷。
- 升级/回滚只改 `.env` 的 `IMAGE_TAG`，然后 `docker compose up -d`；回滚改回上一版标签即可。
- 应用内「设置 → 备份记录」只展示元数据与「立即备份」，不提供下载；恢复请用备份目录中的文件，并确保其 `schema_version` 与程序匹配。
- 数据库 `user_version` 不随代码回滚：新版若已执行迁移，旧版会拒绝启动，需在命令行显式签发回滚放行。

## 其他部署形态

- **Node 裸包（win-x64 / linux-x64）**：需自行安装 **Node.js 26.13.0**（启动时精确校验）。Windows 双击 `start.bat`，Linux 执行 `./start.sh`。数据在包目录的 `data/`、`backups/`、`tmp/`；升级时只替换 `server/` 与 `web/`，保留这三个目录。局域网访问需把启动脚本里的 `PUBLIC_ORIGIN` 改成 `http://<IP>:8080`。
- **Cloudflare Workers**：解压后按包内 README 执行 `npx wrangler deploy`；部署前必须把 `wrangler.toml` 的 `PUBLIC_ORIGINS` 占位域名换成实际地址（或用 `--var` 覆盖）。数据存于 Durable Object 内置 SQLite，备份由平台 PITR 托管。**首次部署务必先限制访问入口**（Cloudflare Access / IP 白名单），完成 `/setup` 后再对外开放，否则任何人可抢先成为管理员。
  - 部署地址由 `wrangler.toml` 的 `name` + 账号的 workers.dev 子域决定（如 `stockin.<子域>.workers.dev`）；仓库变量 `WORKER_PUBLIC_ORIGINS` 只用于注入应用内的来源白名单，**不会改变部署地址**。要换域名：改名，或设置 `workers_dev = false` 并绑定 Custom Domain（`routes`），再同步更新 `PUBLIC_ORIGINS`。
  - GitHub Actions 部署用的仓库变量（Applications → Variables）：
    - `WORKER_PUBLIC_ORIGIN`：**唯一入口**，单值、必须带 scheme（如 `https://stockin.example.com`）。CI 用它作为 `--domain`（Custom Domain）并放在 `PUBLIC_ORIGINS` 首位。
    - `WORKER_EXTRA_ORIGINS`：可选，逗号分隔的额外可信来源（如过渡期的 `https://stockin.<子域>.workers.dev`），只参与来源校验，不参与 `--domain`。
    - `WORKER_PUBLIC_ORIGINS`：旧变量，保留兼容；未设 `WORKER_PUBLIC_ORIGIN` 时取首项作为入口，其余并入额外来源。
    - 三者都为空时，CI 自动解析账号 workers.dev 子域并部署到 `<name>.<子域>.workers.dev`。
    - 使用 Custom Domain 前，域名必须已接入同一 Cloudflare 账号的 zone；API Token 需具备 Workers Routes / Zone 编辑权限。

## 配置速查

模板见 `.env.example`。运行时主要变量：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `8080` | 监听端口；改它必须同步改所有来源的端口 |
| `PUBLIC_ORIGINS` | 回环地址 | 来源白名单，优先级高于单值 `PUBLIC_ORIGIN` |
| `ORIGIN_SCHEME` | `http` | 与来源 scheme 必须一致；`https` 时 Cookie 自动 `Secure` |
| `TZ` | `Asia/Shanghai` | 决定「今天」与临期天数的基准自然日 |
| `DATA_DIR` / `BACKUP_DIR` / `TMP_DIR` | `./data` / `./backups` / `./tmp` | 仅 Node 裸跑；三者不得落在前端静态根之下 |
| `NODE_ENV` / `LOG_LEVEL` | `production` / `info` | 日志级别输出到 stdout |
| `IMAGE_REPO` / `IMAGE_TAG` | 见 `.env` | 仅 Docker 编排层；镜像仓库与版本 |

`RUNTIME_TARGET` 及 11 项平台覆盖项用于 Node / Workers 双运行时切换，正常部署只需设 `RUNTIME_TARGET=workers`（Workers 预设里已设），其余走预设。应用没有密钥型环境变量：账密哈希、salt、会话都在 SQLite，CI 凭据是 GitHub secrets。

## 开发指南

环境要求：**Node.js 26.13.0**（精确断言）与 **pnpm 12**。

```bash
pnpm install          # 安装依赖
pnpm dev              # 并行启动前后端；前端代理 /api 到后端，保持同源
pnpm verify           # 完整门禁：lint → typecheck → test:coverage → build
pnpm build            # 构建全部包
pnpm test             # 仅跑测试
pnpm format           # 格式化后端与共享包源码
```

`pnpm verify` 是发布前的唯一门禁命令（不是 `pnpm ci`）。测试通过真应用装配与真 SQLite 走 HTTP 层，不 mock 中间件或数据库；覆盖率口径覆盖 `packages/domain`、`packages/shared` 与 `apps/server/src`，阈值 70/70/70/65。

### 目录结构

```
apps/
  web/          Umi 4 + React 18 + Ant Design 5；约定式路由，构建产物 web/dist
  server/       Hono 服务：REST API、静态托管、安全/CSRF/会话中间件、SQLite、备份调度
packages/
  shared/       DTO、枚举、错误码、Zod schema、EXCEL_HEADERS（Excel 列序单一真源）
  domain/       零 IO 纯函数：三选二联动、日历钳制、定点运算、临期判定、判重、聚合口径
scripts/        质量门禁、制品打包、Docker 启动脚本模板
.github/workflows/release.yml   验证 → 发布镜像/Release → Workers 部署
```

依赖方向固定：`apps/* → domain → shared`。SQL 只允许出现在 Repository；业务规则放 `domain`，前端复用同一份实现做即时联动。

构建产物：`apps/server/dist/index.js`（Node 单文件 CJS）、`apps/server/dist/worker.mjs`（Workers ESM）、`apps/web/dist/`。单文件打包后无需 `node_modules` 即可运行。

## 许可证

[MIT](./LICENSE) © Summer Flower
