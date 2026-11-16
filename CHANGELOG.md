# 变更记录

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 约定。
每段以版本标题 + 日期开头；未发布改动统一放在 `Unreleased` 段，正式发版时再改为版本号与日期。

## [Unreleased]

### Added

- 根目录 `README.md`：面向使用者与开发者的部署、配置、备份恢复与开发说明。
- 根目录 `LICENSE`：MIT 许可证，版权归 Summer Flower。
- HTTP 层集成测试（真应用装配 + 真 SQLite，不 mock 中间件或数据库），补齐路由 / Service / 中间件的覆盖空白。
- `packages/domain`、`packages/shared` 与整个 `apps/server/src` 纳入覆盖率统计口径，阈值维持 70/70/70/65。
- Cloudflare Workers 双运行时支持：同一份后端代码可跑 Node 与 Workers，差异集中在平台适配层。

### Changed

- 质量门禁 `pnpm verify` 增加共享包预构建（`prebuild`）阶段：先构建 `@stockin/shared` 与 `@stockin/domain` 再跑 lint / typecheck，修复干净 checkout 时 `Cannot find module '@stockin/shared'` 的失败。
- 发布镜像基础切换为 OpenCloudOS 9 minimal；发布制品收紧（win/linux 包不再夹带 Worker 产物）。
- GitHub Release 发布说明改为简短模板：一行摘要 + 指向本 CHANGELOG 的链接，完整变更记录在此集中维护。
- 权限按 job 收敛：只有 `publish` 持有写权限，`verify` / `workers` 只读。
- 预发布资产名固定为 `stockin-pre-*`，滚动覆盖，不再随提交号累积旧资产。

### Fixed

- 登录改为用户名与密码双校验（恒定时间比较，不短路，避免账号枚举旁路）。
- 进程内状态收敛：限流失败桶与幂等快照改用带 TTL 清理的映射，不再只增不删。
- 安全头下发统一为单一实现，中间件与错误处理共用，500 响应同样带 CSP。
- CSRF 拒绝日志补齐 `clientIp`（来源中间件前移）。
- `wrangler.toml` 的可信来源改为占位域名，不再泄漏账户子域。
- 根目录遗留的 `stockin-0.1.0.tar.gz` 压缩包已移除。
