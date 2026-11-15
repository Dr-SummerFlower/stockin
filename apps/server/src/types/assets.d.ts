/**
 * Vite `?raw` 导入的类型声明。
 *
 * Workers 侧需要把 `migrations/*.sql` 以字符串内联进 bundle（没有持久文件系统），
 * 使用 Vite 的 `?raw` 后缀导入。`tsc` 不认识这个后缀，所以在这里补一条
 * 通配模块声明；实际解析由 Vite 在构建期完成。
 */
declare module '*?raw' {
  const content: string;
  export default content;
}
