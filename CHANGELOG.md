# 变更记录

## [1.4.0] - 2026-11-28

### 新增

- **release**：增加 pnpm pre 与 Worker Preview ([e9dc346](https://github.com/Dr-SummerFlower/stockin/commit/e9dc3461b18174c7da1abbb0e18812aa6e2e6c1f))
- **backup**：建立加密逻辑备份基础 ([d8c2bbd](https://github.com/Dr-SummerFlower/stockin/commit/d8c2bbd4c4f86026c5fd5cef2fdbb52a1d7731e3))
- **backup**：完成加密逻辑备份与恢复闭环 ([242a816](https://github.com/Dr-SummerFlower/stockin/commit/242a8163ad00355ed8f0df2948ccc175d2cc94b5))
- **server**：备份公钥入库与升级双备份、统计分页改造（schema 6） ([0d813c4](https://github.com/Dr-SummerFlower/stockin/commit/0d813c4046f3442d88f01694543767870b55d94f))
- **web**：进货单录入页面与手机端重排 ([5daeaf0](https://github.com/Dr-SummerFlower/stockin/commit/5daeaf0e18e2ec2ab1576d4e02f9c95e436d0349))
- **server**：进货单契约与接口实现（schema 7） ([0a16fb5](https://github.com/Dr-SummerFlower/stockin/commit/0a16fb571190eda8846b943a328f94bbd2d56b63))
- 进货单体验增强（步进器/续行/导出/按供货商候选） ([7ca1a0d](https://github.com/Dr-SummerFlower/stockin/commit/7ca1a0d78110de364748340c8fe59fe7e9420f44))
- **server**：Excel 导出接入美化样式并新增单张进货单导出 ([46c6e3b](https://github.com/Dr-SummerFlower/stockin/commit/46c6e3b68262581a567f862f4c03a08a14468f0a))
- **web**：进货单详情页移除打印改为导出 xlsx ([231c77b](https://github.com/Dr-SummerFlower/stockin/commit/231c77b2a09e0de977cd9e14de3a79e8ab163195))

### 修复

- **release**：收敛发布流程并保留预发布构建 ([2787b2c](https://github.com/Dr-SummerFlower/stockin/commit/2787b2cd124b3e24e1d2cf1f1cb9ea2da7956d50))
- **pre**：统一用 git tag 触发预发布 ([ddaa588](https://github.com/Dr-SummerFlower/stockin/commit/ddaa5889badd0e02f266f285c5a759b9db1720f3))
- **pre**：限制只能在 main 分支预发布 ([55881f8](https://github.com/Dr-SummerFlower/stockin/commit/55881f8f623ea723efd0c6c6aa71c13db73daca3))
- **web**：修正手机端多处细节布局问题 ([a2c2abf](https://github.com/Dr-SummerFlower/stockin/commit/a2c2abf27630afb836f26706dcf8d2e8f4fd83f9))
- **shared**：对齐恢复票据签名长度上限与注释 ([6501be3](https://github.com/Dr-SummerFlower/stockin/commit/6501be3e007f543b717ed98a27f6b3d43fa77a3c))
- **server**：修复逻辑备份调度、迁移兼容与恢复校验缺陷 ([5673ddb](https://github.com/Dr-SummerFlower/stockin/commit/5673ddb34e661fe5e4c4fbaa9116cdb1d47e8e7a))
- **web**：恢复面板区分票据文件解析失败 ([2886cf4](https://github.com/Dr-SummerFlower/stockin/commit/2886cf4c91036c0e80fda3e2627cabb7f275b038))
- **deploy**：透传逻辑备份公钥并隔离本地密钥目录 ([b9cb59e](https://github.com/Dr-SummerFlower/stockin/commit/b9cb59e84db3bc9c88319383eaad960752a1e791))
- **server**：迁移 SQL 末条语句后不得残留注释（修 pre 预览 1101） ([5daec2b](https://github.com/Dr-SummerFlower/stockin/commit/5daec2b072d7c2f08900228b3e7577ed53c093bf))
- **server**：逻辑备份排除平台内部表（修 Workers 备份卡在 running） ([20bbe05](https://github.com/Dr-SummerFlower/stockin/commit/20bbe05b0b044cf80c4bf037338be8ad6324abe4))
- 进货单联调与审查问题修复 ([30d7701](https://github.com/Dr-SummerFlower/stockin/commit/30d7701605c49aa2cbce6dcc0c1addb552c04b31))
- **server**：逻辑备份 tick 重入保护与终态守卫 ([b206f42](https://github.com/Dr-SummerFlower/stockin/commit/b206f42580e898bc3b1601528ba507fa947fc053))
- 审查问题批次修复（金额双向一致性 / DO changes / HSTS / 错误原因） ([3c2b309](https://github.com/Dr-SummerFlower/stockin/commit/3c2b309d54335515991f2a8006950ad8334e695b))
- CSP nonce 放行 CF 注入脚本 + 备份公钥运行期补播种 ([10d51e4](https://github.com/Dr-SummerFlower/stockin/commit/10d51e42e3a956f739474c2144df88cf7a088462))
- **ci**：备份公钥 Secret 改为写入 Worker Preview 而非独立 Worker ([ca996b0](https://github.com/Dr-SummerFlower/stockin/commit/ca996b0a4bad9dd221fe83197449734a1ff83f41))
- **web**：进货单三选二完整可编辑并整理录入排版 ([b3c1a65](https://github.com/Dr-SummerFlower/stockin/commit/b3c1a65e0fc46f30e335bb1b15ef514ef7f6a0f8))
- **release**：每个 pre tag 生成独立预发布 Release ([81efd6e](https://github.com/Dr-SummerFlower/stockin/commit/81efd6e0b9a0a043e29f85a14c63e16a61f745e2))
- **web**：修复手机底部「记一笔」加号偏上偏小 ([50b7551](https://github.com/Dr-SummerFlower/stockin/commit/50b7551581b1f3981760ec2f706e266ba12e4940))
- **admin**：登录失败审计区分 login 与 error ([b9e832c](https://github.com/Dr-SummerFlower/stockin/commit/b9e832c436d13582d3e27a849bdad5f0104deeff))
- **release**：构建版本取发布 tag，预发布显示 pre-<sha7> ([ba81007](https://github.com/Dr-SummerFlower/stockin/commit/ba81007c0c693579e72abf0a60a0995c194cf366))
- **web**：管理台备份模式说明按实际运行时修正 ([5cd9fc9](https://github.com/Dr-SummerFlower/stockin/commit/5cd9fc9ce5703d55c7e13998e011a62e035b200e))
- **admin**：统一开发态 localhost，OAuth 回调后回跳前端 8000 ([c76c067](https://github.com/Dr-SummerFlower/stockin/commit/c76c067e30940cc3df535f3164e0fcd24dbd76e2))
- **server**：调整进货单导出的标题与打印日期格式 ([4d09958](https://github.com/Dr-SummerFlower/stockin/commit/4d09958128a9caadfaee09f5500349a7ab90f5c6))

### 重构

- **server**：单张进货单导出改为单 sheet 打印分页 ([9509281](https://github.com/Dr-SummerFlower/stockin/commit/950928109f9ef323f062760d91b42bf092e5f89b))

### 测试

- **server**：补齐覆盖率断层并上调门槛 ([1c443e2](https://github.com/Dr-SummerFlower/stockin/commit/1c443e28977245b487aea30eb1dc2dbd2f57c933))

### 文档

- 同步 README 至进货单与 Excel 新导出能力 ([c90f272](https://github.com/Dr-SummerFlower/stockin/commit/c90f2723ab2165173519dd45c5963e5317538e47))

### 持续集成

- **release**：Release 正文去掉完整变更记录链接 ([e334f79](https://github.com/Dr-SummerFlower/stockin/commit/e334f796e1115a2a13d6c3dd6c2c97209c0e6e46))

### 杂项

- **verify**：清理 verify 全链路告警（43 条 → 0） ([b3662b2](https://github.com/Dr-SummerFlower/stockin/commit/b3662b2da9fa89b5922ae23787ffd35e802a7575))

### 其他

- **web**：虚线框标出进货单日期组与金额组 ([4d37ea1](https://github.com/Dr-SummerFlower/stockin/commit/4d37ea1cbcc670a37dbd8fb2fa377464d3416d57))
## [1.3.1] - 2026-11-22

### 修复

- **release**：本地归档 CHANGELOG 并恢复 tag 触发发布 ([20049c0](https://github.com/Dr-SummerFlower/stockin/commit/20049c0ac886b2c2d0a742935f3e12a4a3021c6b))
## [1.3.0] - 2026-11-22

### 新增

- **ci**：按提交自动计算版本并完成发版 ([6f5522d](https://github.com/Dr-SummerFlower/stockin/commit/6f5522d5c214b2f7b40889984abf70c076d745c9))

### 修复

- **web**：修复输入法合成中间态污染输入值 ([86d5a91](https://github.com/Dr-SummerFlower/stockin/commit/86d5a914de81e5f045cacd4567f253bea2adefe2))
- **server**：修复商品搜索不支持包含匹配 ([08cfda9](https://github.com/Dr-SummerFlower/stockin/commit/08cfda91bac9de8650d66fef68c87331aab62621))
- **release**：复用本机 gh 凭据访问加速远端 ([066e872](https://github.com/Dr-SummerFlower/stockin/commit/066e87272bba08247ecb474030cdf12571b534fe))
## [1.2.2] - 2026-11-17

### 修复

- **ci**：区分边缘层拦截与应用故障，收紧自动回滚条件 ([a762b1e](https://github.com/Dr-SummerFlower/stockin/commit/a762b1eefc74934eddabb233ac7152f89111da93))
## [1.2.1] - 2026-11-17

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
