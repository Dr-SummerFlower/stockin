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

首次启动直接打开 `http://localhost:8080`，页面会进入 `/setup` 自助引导：

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
- **升级自动备份（Node / Docker / 裸包）**：只要启动时发现有未执行的迁移脚本，会按固定顺序产出两份备份：
  1. **物理快照**（整库文件，改结构**之前**取）：落在 `stockin-backups` 卷，保留 7 份，是**回滚用的那份**；
  2. **逻辑备份**（加密、可下载、可本地解密，改结构**之后**取）：写入 `backups` 表并计入 5 份保留额度，启动日志打印 `[BOOTSTRAP] 升级后已生成逻辑备份` 与 `backupId`。

  顺序不能反：物理那份必须早于迁移，否则取到的已经是新结构、回不到旧版本；逻辑那份放在迁移成功之后，读到的是新结构数据，`schemaVersion` 记的就是升级后的版本，可以在当前版本直接恢复。两份用途不同：物理快照能整库回到升级前（前提是回到旧版本二进制），逻辑备份可以拷走、可以 `pnpm backup:decrypt` 在别的机器上解开看内容，机器没了也还在。
- **升级自动备份（Cloudflare Workers）**：不生成逻辑备份。`bootstrap()` 发生在 Durable Object 首次请求内，整库导出要在这里同步推完上百个 chunk，128MB 内存与单次 CPU 预算都撑不住；那边的物理备份本来由平台 PITR 托管。需要额外一份逻辑备份时，**升级前**先在管理台点「立即备份」。
- **schema 6 起**：备份公钥与仪表盘统计表入库。跨 schema 版本的恢复票据会被拒绝（票据里带 `schemaVersion`），所以**旧版本生成的备份不能在新版本里恢复**，只能本地 `backup:decrypt` 解密查看；升级流程会在迁移成功后自动生成一份新版本的逻辑备份，那份可以直接恢复。

## 其他部署形态

- **Node 裸包（win-x64 / linux-x64）**：需自行安装 **Node.js 26.13.0**（启动时精确校验）。Windows 双击 `start.bat`，Linux 执行 `./start.sh`。数据在包目录的 `data/`、`backups/`、`tmp/`；升级时只替换 `server/` 与 `web/`，保留这三个目录。局域网访问需把启动脚本里的 `PUBLIC_ORIGIN` 改成 `http://<IP>:8080`。
- **Cloudflare Workers**：解压后按包内 README 执行 `npx wrangler deploy`；部署前必须把 `wrangler.toml` 的 `PUBLIC_ORIGINS` 占位域名换成实际地址（或用 `--var` 覆盖），并按「逻辑备份密钥」一节用 `wrangler secret put` 配置公钥。数据存于 Durable Object 内置 SQLite，备份由平台 PITR 托管。**首次部署务必先限制访问入口**（Cloudflare Access / IP 白名单），完成 `/setup` 后再对外开放，否则任何人可抢先成为管理员。
  - 部署地址由 `wrangler.toml` 的 `name` + 账号的 workers.dev 子域决定（如 `stockin.<子域>.workers.dev`）；仓库变量 `WORKER_PUBLIC_ORIGINS` 只用于注入应用内的来源白名单，**不会改变部署地址**。要换域名：改名，或设置 `workers_dev = false` 并绑定 Custom Domain（`routes`），再同步更新 `PUBLIC_ORIGINS`。
  - GitHub Actions 部署用的仓库变量（Settings → Secrets and variables → Actions → **Variables**）：
    - `WORKER_PUBLIC_ORIGIN`：**唯一入口**，单值、必须带 scheme（如 `https://stockin.example.com`）。CI 用它作为 `--domain`（Custom Domain）并放在 `PUBLIC_ORIGINS` 首位。也兼容放在 **Secrets** 中（变量优先、Secret 兜底）。
    - `WORKER_EXTRA_ORIGINS`：可选，逗号分隔的额外可信来源（如过渡期的 `https://stockin.<子域>.workers.dev`），只参与来源校验，不参与 `--domain`。
    - `WORKER_PUBLIC_ORIGINS`：旧变量，保留兼容；未设 `WORKER_PUBLIC_ORIGIN` 时取首项作为入口，其余并入额外来源。
    - 三者都为空时，CI 自动解析账号 workers.dev 子域并部署到 `<name>.<子域>.workers.dev`。
    - 使用 Custom Domain 前，域名必须已接入同一 Cloudflare 账号的 zone；API Token 需具备 Workers Routes / Zone 编辑权限。

## 配置速查

模板见 `.env.example`。运行时主要变量：

| 变量                                        | 默认                             | 说明                                                                                                                                                 |
| ------------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                                      | `8080`                           | 监听端口；改它必须同步改所有来源的端口                                                                                                               |
| `PUBLIC_ORIGINS`                            | 回环地址                         | 来源白名单，优先级高于单值 `PUBLIC_ORIGIN`；**首项是主来源**，决定管理员 OAuth 的回调地址                                                                   |
| `WEB_ORIGIN`                                | 空（= 与后端同源）               | 前端站点源，仅本地开发需要（前端 8000 / 后端 8080）；登录后把浏览器送回前端，生产留空                                                                        |
| `ORIGIN_SCHEME`                             | `http`                           | 与来源 scheme 必须一致；`https` 时 Cookie 自动 `Secure`                                                                                              |
| `TZ`                                        | `Asia/Shanghai`                  | 决定「今天」与临期天数的基准自然日                                                                                                                   |
| `DATA_DIR` / `BACKUP_DIR` / `TMP_DIR`       | `./data` / `./backups` / `./tmp` | 仅 Node 裸跑；三者不得落在前端静态根之下                                                                                                             |
| `NODE_ENV` / `LOG_LEVEL`                    | `production` / `info`            | 日志级别输出到 stdout                                                                                                                                |
| `IMAGE_REPO` / `IMAGE_TAG`                  | 见 `.env`                        | 仅 Docker 编排层；镜像仓库与版本                                                                                                                     |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | 空                               | GitHub OAuth App 凭据；仅管理员登录使用，三者缺一即禁用管理员入口                                                                                    |
| `ADMIN_GITHUB_LOGINS`                       | 空                               | 允许登录的 GitHub 账号名，逗号分隔（大小写不敏感）                                                                                                   |
| `BACKUP_PUBLIC_KEY`                         | 空                               | 备份**默认公钥**（P-256 SPKI/DER base64，单行），仅首次启动、库内无公钥时播种一条；此后加密/验签只读库内，轮换在管理台做。Workers 上以 **Secret** 配置 |

`RUNTIME_TARGET` 及 11 项平台覆盖项用于 Node / Workers 双运行时切换，正常部署只需设 `RUNTIME_TARGET=workers`（Workers 预设里已设），其余走预设。除管理员 OAuth 三项（Workers 上以 Secret 形式配置）与首次播种用的逻辑备份默认公钥 `BACKUP_PUBLIC_KEY` 外，应用没有密钥型环境变量：账密哈希、salt、会话都在 SQLite，CI 凭据是 GitHub secrets；逻辑备份私钥只保存在部署机的 `.keys/`，从不进入运行环境。

### 逻辑备份密钥（生成 / 部署 / 轮换）

服务端只持有公钥：每次备份随机生成 AES-256 数据密钥，用公钥封装后随备份落库；私钥只在本地 `pnpm backup:decrypt / ticket / restore` 时出现。

- **生成**：`pnpm backup:keygen` → `.keys/<keyId>.public.key`、`<keyId>.private.key`、`active`。重复执行只会**新增**一对密钥（文件名带 keyId，不覆盖任何旧文件）；只有加 `--activate` 才把签名密钥切到新密钥。
- **公钥的唯一真源是管理台**：`/admin` →「备份公钥」，粘贴 `.keys/<keyId>.public.key` 的整行内容即可。库里**启用中**的那把用于加密新备份，库内全部公钥用于验签。轮换只需在这里点两下，**不用重新部署**，也不需要 Cloudflare 账号权限。
- **首次启动播种**：库内 `backup_keys` 为空时，bootstrap 把 `BACKUP_PUBLIC_KEY` 写入一条启用中的默认公钥；此后该变量不再参与任何运行期逻辑，删改轮换全在管理台完成。Workers 上以 Secret 注入：

  ```bash
  printf '%s' "$(cat .keys/<keyId>.public.key)" | npx wrangler secret put BACKUP_PUBLIC_KEY
  ```

  **不要**再用 `--var BACKUP_PUBLIC_KEY:...`：那是明文变量，会留在 Worker 的 vars 配置里（控制台可读，且会被 wrangler 的配置差异警告回显到日志）。CI 会在 `wrangler deploy` 之后自动执行这条 `secret put`。若首次启动时未配置该变量，实例将以「尚无公钥」状态启动，到管理台添加一把公钥即可启用备份。

- **轮换（管理台，三步）**：
  1. `pnpm backup:keygen -- --activate` 生成新密钥并把它切成**签名**密钥；
  2. 管理台「备份公钥」→ 粘贴新公钥 → 勾选「立即设为加密公钥」→ 添加。之后的新备份立刻改用新公钥，旧公钥自动退为「仅验签」；
  3. 旧私钥**留在** `.keys/`（`backup:decrypt` 按备份 meta 的 `keyId` 自动选键，旧备份照样能解）。旧公钥可以随时在面板里删掉。
- **旧公钥不必全部保留**：服务端公钥**不参与解密**——解密只需要本地私钥 + 备份 meta 里的 `keyId`。退休一把旧公钥的唯一后果是「用对应私钥签出的恢复票据不再被接受」，而票据有效期只有 30 分钟。所以清理旧公钥是安全的；真正要长期保存的是 `.keys/` 里的**旧私钥**。
- **篡改检测**：备份 meta 的 `keyId` = 公钥 SHA-256 前 32 位。若服务端公钥被人换掉（无论是改 Secret 还是改库里的记录），新备份的 keyId 与本地私钥对不上，`backup:decrypt` 会直接报「密钥环里没有能解封该备份的私钥」并列出本地可用 keyId，而不是含糊的解密失败。这是公钥被替换时唯一可靠的信号（有写权限的人防不住，能防的是「悄悄换掉且无人察觉」）。

- **验证下载的备份确实可用（演练）**：从管理台下载 `.ndjson` 后，在本地跑

  ```bash
  pnpm backup:decrypt --in ~/Downloads/<backupId>.ndjson      # 默认密钥环 .keys/
  ```

  这一步会按密钥环自动选键，并逐层校验：格式版本 → chunk 序号是否连续 → 每个 chunk 的 AES-GCM 认证与 sha256 → chunk 内 `table/seq` 与行元数据是否一致 → chunk 总数是否等于 `meta.chunkCount` → manifest 摘要是否等于 `meta.manifestSha256`。任一层不符都会直接失败并指明位置（`chunk 12 sha256 不匹配` / `manifest 摘要不匹配，备份可能已被篡改`），**不会**产出半截恢复包。
  通过后在 `.tmp/restore/` 得到 `restore-package.ndjson` 与 `restore-package.info.json`（含 `backupId` / `schemaVersion` / `keyId` / `dataSha256`），终端会打印 `[decrypt] 完成：N 张表，keyId=…（用 .keys/<keyId>.private.key）`。**能解封并输出这个 `keyId`，就说明「这把私钥 + 这个公钥 + 这份备份」三者对得上。**
  想做端到端恢复演练，把恢复包推到一台**临时**实例（不要指向生产）：

  ```bash
  pnpm backup:restore --origin https://<临时实例> --cookie '<admin sid>' \
    --package .tmp/restore/restore-package.ndjson --ticket /tmp/ticket.json
  ```

  建议每季度至少演一次，同时确认 `.keys/` 里的旧私钥还在（旧备份唯一的解封钥匙）。

### 容量参考（实测，2026-11-24）

以「2,000 种商品 × 每月一次进货 × 5 年」= **120,000 条**记录为例（Node 26.13.0 + `node:sqlite`，真实迁移脚本建库）：

| 项目                                              | 体积                    | 单条  |
| ------------------------------------------------- | ----------------------- | ----- |
| SQLite 库文件（含 8 条索引）                      | 43.0 MB                 | 376 B |
| 逻辑备份明文                                      | 26.7 MB（600 个 chunk） | 233 B |
| 逻辑备份下载文件（密文 + base64 + NDJSON 元数据） | 35.7 MB                 | 312 B |
| 恢复包（本地解密产物）                            | 26.5 MB                 | 231 B |

对应的配额结论：Worker 恢复上限 10MB ≈ 4.5 万条，Node 32MB ≈ 14.5 万条（覆盖上述极端数据量）；
Workers 免费版另有「DO SQLite 每日 10 万行写入」与「单 DO 1GB 存储」（5 份备份 × 36MB + 库 43MB 仍在限内）。
超过 4.5 万条的恢复请用自托管 Node 实例，或在付费版上把 `limits.cpu_ms` / 存储额度调高后自行放宽上限。

### 长期运行（只写不恢复）的配额余量

以上极端量（12 万条 / 5 年）**不恢复、只日常使用**时，四条免费版硬限制的实际占用：

| 维度    | 免费版上限        | 第 5 年的实际值                             | 余量      |
| ------- | ----------------- | ------------------------------------------- | --------- |
| 行写入  | 10 万 / 日        | ≈ 66 条新记录（按 12 万 ÷ 5 年 ÷ 365 摊薄） | 极宽裕    |
| 行读取  | 500 万 / 日       | 列表页 ≈ 50 行；仪表盘 ≈ 数千行             | 极宽裕    |
| DO 存储 | 1 GB（账号 5 GB） | 库 43 MB + 5 份备份 ≈ 180 MB ≈ 223 MB       | 约 4.5 倍 |
| 请求数  | 10 万 / 日        | 单人自用，日均百次级                        | 极宽裕    |

两条前提都已内建在代码里，不需要人工干预：

- **列表页必须有查询统计**：`bootstrap` 会自动执行 `ANALYZE`（已有统计且行数没翻倍时跳过）。缺 `sqlite_stat1` 时 SQLite 会把列表查询判成「扫全表 + 临时 B 树排序」——12 万行下 63ms、一次吃掉 12 万行读取额度，还把这些行搬进 128MB isolate；有统计后是 0.12ms、扫 50 行（实测，见 `CONVENTIONS.md` §3）。
- **仪表盘指标是增量维护的派生表**（`record_stats` / `record_product_stats` / `record_expiry_stats`，由触发器逐行更新）。临期/过期按到期日分桶，读取时做区间求和：第 5 年一次刷新是「1 行 + 商品种类行数 + 窗口内桶数」，与总行数无关；全量恢复后在同一个恢复事务内由 `RecordStatsRepository.rebuildInTransaction()` 一次性重算。

### 管理员入口与 GitHub OAuth

店主账号负责日常经营，管理员是**独立的系统维护身份**，权限互不交叉。管理员只做备份、数据导出、审计导出、店主凭据重置与系统概览，**不读写任何业务记录**。

- **开启方式**：创建一个 GitHub OAuth App（Homepage URL 填应用入口，Authorization callback URL 填 `<入口>/api/admin/auth/github/callback`），把 `GITHUB_CLIENT_ID`、`GITHUB_CLIENT_SECRET` 配成 Secret，`ADMIN_GITHUB_LOGINS` 填白名单账号名（如 `alice,bob`）。三个变量在 Workers 上以 **Secret（加密）** 形式添加；Node 侧写入进程环境即可。三项缺一，管理员入口返回「未配置」，店主侧完全不受影响。
- **登录入口**：`/admin/login` → 点击用 GitHub 账号登录 → 回调成功后进入 `/admin`。白名单外的 GitHub 账号一律拒绝，并写失败审计。
- **会话语义**：管理员 Cookie 是**窗口级**（不设过期时间），关闭浏览器即丢弃；服务端另有 30 分钟空闲 / 12 小时绝对双过期兜底。与店主会话（`sid`）使用不同的 Cookie 名和独立数据表，互不识别。
- **安全审计**：管理员的全部维护动作，以及店主的登录、批量删除/恢复/清除、设置/凭据变更等关键操作，都写入 append-only 的 `operation_logs`，可通过管理台导出 CSV。

### 合规与日志留存

- **应用访问日志**（每条 Web 请求的 method/path/耗时）只输出到 stdout，由 Docker `json-file` 驱动或平台日志系统滚动收集，**不写入数据库**。
- **安全审计日志**（`operation_logs`）append-only，保留期按**网络安全法第 21 条**与等保 2.0 安全审计要求执行：身份鉴别、访问控制、不可逆/批量操作与系统维护事件需可追溯，留存不少于 6 个月。备份 GC 与清理逻辑不会删除仍在该窗口内的审计行。日常记录增删改、模板下载、数据导出与退出登录不写审计（记录行自身带时间戳与来源位，足以追溯），以降低噪音。
- 关于「公安部 176 号令」：该办法是**监督检查规定**，本身不直接规定日志留存期限；「6 个月」的实际法源是网络安全法与等保的审计要求。此处按其口径就高执行。

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

开发态固定两个端口：**前端 8000（Umi dev server）、后端 8080（Hono）**，一律用 `localhost` 访问 `http://localhost:8000` —— 后端在 dev 下不托管静态产物，直接开 8080 只会得到白屏。主机名不要混用 `127.0.0.1`：Cookie 按 host 隔离（不区分端口），管理员 GitHub OAuth 的回调落在 8080，浏览器若在别的 host 上发起登录，state Cookie 会带不过去（`/admin/login?error=state`）。

管理员登录的链路是「前端 8000 发起 → GitHub → 回调 8080 → 跳回前端 8000」：回调地址由 `PUBLIC_ORIGINS` 首项推导，必须与 GitHub OAuth App 里登记的 `http://localhost:8080/api/admin/auth/github/callback` 逐字一致；回跳目标由 `WEB_ORIGIN` 决定，本地 `.env.local` 写 `WEB_ORIGIN=http://localhost:8000` 即可。生产由 Hono 同源托管，`WEB_ORIGIN` 留空，跳转走相对路径。

`pnpm verify` 是发布前的唯一门禁命令（不是 `pnpm ci`）。测试通过真应用装配与真 SQLite 走 HTTP 层，不 mock 中间件或数据库；覆盖率口径覆盖 `packages/domain`、`packages/shared` 与 `apps/server/src`，阈值 85/70/90/85（行 / 分支 / 函数 / 语句）。

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
