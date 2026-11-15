/**
 * Worker 内部路径常量。
 *
 * 单独成文件的原因很具体：**Worker 入口模块的具名导出必须是
 * `ExportedHandler` 或可绑定的类**。把字符串常量直接从 `worker.ts` 导出，
 * workerd 启动时会直接报
 * `Incorrect type for map entry 'INTERNAL_PATH_PREFIX': the provided value is
 * not of type 'function or ExportedHandler'`。
 *
 * 放在这里后，`worker.ts` 只导出 Durable Object 类与 default handler，
 * 常量随打包内联、不出现在入口导出面上。
 */

/** DO 内部路径前缀；Worker 入口会拦掉同名外部请求，避免被外部触发备份。 */
export const INTERNAL_PATH_PREFIX = '/__runtime/';

/** 触发一次定时备份的内部路径。 */
export const INTERNAL_SCHEDULED_PATH = `${INTERNAL_PATH_PREFIX}scheduled`;
