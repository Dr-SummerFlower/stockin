# 变更记录

## [Unreleased]

### 修复

- **ci**：冒烟探测同时覆盖自定义域与 workers.dev ([33ec781](https://github.com/Dr-SummerFlower/stockin/commit/33ec781366f6a143e6ce176c0bdaa19008e065f5))
- **ci**：部署 URL 提取排除 wrangler 配置警告中的假域名 ([11b56fa](https://github.com/Dr-SummerFlower/stockin/commit/11b56faaa884a71e7c871540d43e0f71e3444d94))
## [1.2.0] - 2026-11-17

### 新增

- **shared**：管理员体系契约与审计动作精简 ([6841473](https://github.com/Dr-SummerFlower/stockin/commit/6841473f37340465dc1d6497b4ee25614d3729a4))
- **server**：管理员 GitHub OAuth 体系与系统维护端点 ([ef5f760](https://github.com/Dr-SummerFlower/stockin/commit/ef5f7603a8a711e8a3f9cf13d5453b57f7ad0f76))
- **web**：管理员登录页与系统维护台 ([95fad49](https://github.com/Dr-SummerFlower/stockin/commit/95fad4988edd405c2cf2480e7d6538801b34d026))

### 修复

- **dev**：后端 dev 加载本地 .env 并改用原生 watch 热重载 ([1a0daeb](https://github.com/Dr-SummerFlower/stockin/commit/1a0daeb713fe93f88842058c167fa4661d9afe63))

### 重构

- **server**：精简操作日志，仅保留关键操作 ([ffe7fa2](https://github.com/Dr-SummerFlower/stockin/commit/ffe7fa28e460af4558fccb9a6055c0253f48a904))

### 测试

- 管理员端点集成测试与迁移断言更新 ([bedc256](https://github.com/Dr-SummerFlower/stockin/commit/bedc256e5cc9c6fab5dc49aeeec1c92866c52753))

### 文档

- 管理员 OAuth 配置与合规日志留存说明 ([432760f](https://github.com/Dr-SummerFlower/stockin/commit/432760f186c1b0a20a6fd517ce68ad47e8396916))
## [1.1.2] - 2026-11-17

### 修复

- **ci**：自定义域部署不再强依赖 workers.dev 地址 ([6a83358](https://github.com/Dr-SummerFlower/stockin/commit/6a833580c7dd117e0d5bd2826bc5f977c4bf62d8))
## [1.1.1] - 2026-11-17

### 修复

- **ci**：兼容将 Worker 入口域名存放在 Secret ([42ea686](https://github.com/Dr-SummerFlower/stockin/commit/42ea686a571b97f7aa8fa72eb7a0bfd2db1dd5ac))
## [1.1.0] - 2026-11-17

### 新增

- **auth**：自助引导、账号安全与录入建议接口 ([c8b2097](https://github.com/Dr-SummerFlower/stockin/commit/c8b2097f8467d58a5471151c7550765f225c494b))
- **web**：账号安全页、输入建议与首次漫游 ([b8520fc](https://github.com/Dr-SummerFlower/stockin/commit/b8520fc89e28fc12f7d4241baecd50473a9a97aa))

### 修复

- **server**：修正 dev 模式迁移目录解析 ([102834c](https://github.com/Dr-SummerFlower/stockin/commit/102834ce0d986aa7fdf8fabb8554ce09ee2b5b47))

### 持续集成

- **workers**：单入口域名变量与 Custom Domain 注入 ([38e6867](https://github.com/Dr-SummerFlower/stockin/commit/38e68677a7c6cbcee41cad663174323c0d825777))
## [1.0.0] - 2026-11-16

### 新增

- **domain**：实现 shared 契约层与 domain 纯函数层 ([40f54b5](https://github.com/Dr-SummerFlower/stockin/commit/40f54b5fffc21c88947cd6a615b8032f71efd2e4))
- **server**：实现数据层、迁移、备份与启动基础设施 ([ef52c1d](https://github.com/Dr-SummerFlower/stockin/commit/ef52c1d3709e2aac33c82b2a5306a1fec5446ae6))
- **server**：实现中间件链、业务服务与全部 API 端点 ([8b08141](https://github.com/Dr-SummerFlower/stockin/commit/8b081419494c40db51b6de12ecea8f87e874f455))
- **web**：实现 Umi 前端页面、联动表单与统计大屏 ([d1c2975](https://github.com/Dr-SummerFlower/stockin/commit/d1c2975f195aa6329ee6cb356a893230b96c0093))
- **deploy**：增加 Dockerfile、docker-compose.yml 与 .dockerignore ([1bd6d5c](https://github.com/Dr-SummerFlower/stockin/commit/1bd6d5c99720cd2499084fede1ef5454b19dd69d))
- UI 去装饰化重写 + CSP/CSRF 安全修复 + 部署配置完善 ([fde068e](https://github.com/Dr-SummerFlower/stockin/commit/fde068e35fc1e5d850a01129788ace97233486b2))
- **server**：同一份后端代码适配 Node 与 Cloudflare Workers 双运行时 ([9c659db](https://github.com/Dr-SummerFlower/stockin/commit/9c659dbdd2b065fe0016cbd72aa051c42aa402cd))

### 修复

- **server**：修复首页 ETag、health 查库、迁移路径与静态根配置 ([2284999](https://github.com/Dr-SummerFlower/stockin/commit/22849992ff384a6e689e5ce23aff4cfe13b2d3f0))
- **server**：让 WEB_DIST_DIR/env.staticRoot 真正生效，裸跑时回落 cwd 无关兜底 ([8093c5c](https://github.com/Dr-SummerFlower/stockin/commit/8093c5cd7ef7d34acab8b35c4bd8c30693a4b61f))
- **web**：首启改为先登录、用初始密码登录后跳转设置密码页 ([8671e1f](https://github.com/Dr-SummerFlower/stockin/commit/8671e1f7e69cfffb25f25e1b3c479f2c834dbfd3))
- **web**：Dev 代理目标端口 3000→8080，消除 umi dev 下 /api 504 ([c088af5](https://github.com/Dr-SummerFlower/stockin/commit/c088af5bc64b0365573d1cb99c1d1fb2ad69ce0c))
- **web**：Dev 代理重写 Origin/Referer 对齐 PUBLIC_ORIGIN，修复 umi dev 下登录/退出 403 ([b280b13](https://github.com/Dr-SummerFlower/stockin/commit/b280b1362680678174dcfac5e7b4413f82d0ab54))
- **web**：布局移出 src/layouts/index.tsx 约定路径，消除 Umi 全局布局导致的双层嵌套 ([4be2da6](https://github.com/Dr-SummerFlower/stockin/commit/4be2da63c59f2f2a99533b771c0160c5baa510b6))
- **server**：收敛进程内状态与安全头，登录改用户名密码双校验 ([a3785f0](https://github.com/Dr-SummerFlower/stockin/commit/a3785f0b3af2fc9d624203f2163d74284e0560b1))
- **ci**：门禁前预构建共享包，修复干净 checkout 的类型检查失败 ([e737de1](https://github.com/Dr-SummerFlower/stockin/commit/e737de128e528e2d7fd51e352ca44ae70fd7a5fd))
- **release**：发布说明去掉通道与版本前缀重复 ([f137015](https://github.com/Dr-SummerFlower/stockin/commit/f137015bbfbefa23fa368e592579e6ebe8c900f2))

### 重构

- **db**：换用 Node 内置 node:sqlite 并抽出数据层端口 ([110adcd](https://github.com/Dr-SummerFlower/stockin/commit/110adcdd72d5317d82b0aa9de5fc8cb0b370b45e))

### 测试

- **server**：补 HTTP 层集成测试，覆盖率口径扩到全后端 ([26d0ca4](https://github.com/Dr-SummerFlower/stockin/commit/26d0ca433f8ab950729c1b3d377ee362da7060d0))

### 文档

- 补全根目录 README 与 MIT LICENSE ([3b8b422](https://github.com/Dr-SummerFlower/stockin/commit/3b8b422f606e8b3dafb2b68a3085f7b6616f33ad))

### 构建

- 全栈切换 Vite 引擎 + 补齐单测与 lint 质量门禁 ([1b3c1a7](https://github.com/Dr-SummerFlower/stockin/commit/1b3c1a7bfb334bf5ec0985037706acfdbd4fc99d))
- **docker**：基础镜像换成 OpenCloudOS 9 minimal ([319e538](https://github.com/Dr-SummerFlower/stockin/commit/319e538a6fcbb49d7a3dae0aa5525d62e41ee161))
- **release**：收紧发布制品与部署配置 ([a496c58](https://github.com/Dr-SummerFlower/stockin/commit/a496c5892844c23db3a7a5b6380898654c0f780e))

### 杂项

- 初始化项目框架与设计文档基线 ([c518073](https://github.com/Dr-SummerFlower/stockin/commit/c518073c6cd77e73b11ee15e85d3769b8feb9362))
- 收紧 .gitignore，仓库只保留生产构建与部署所需文件 ([0781086](https://github.com/Dr-SummerFlower/stockin/commit/0781086e0cd61caf221dc6c87085c43989a1eedf))
- 移除 package.json 里 pnpm 12 已忽略的 pnpm 字段 ([9a58829](https://github.com/Dr-SummerFlower/stockin/commit/9a5882920c2cca38af7c64acc7bd34da0083176f))
