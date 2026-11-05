/**
 * 前端全局类型补充。
 *
 * - `window.__STOCKIN_CHUNK_ERROR__`：chunk 加载失败兜底的一次性安装标记。
 * - `*.css`：Umi 生成的 typings 在 `src/.umi` 下（被 tsconfig exclude），
 *   这里补一份无导出的环境声明，保证 `import '*.css'` 在 `tsc --noEmit` 下可解析；
 *   与 Umi 生成的声明合并时不会重复导出 default，故无冲突。
 */

interface Window {
  __STOCKIN_CHUNK_ERROR__?: boolean;
}

declare module '*.css';
