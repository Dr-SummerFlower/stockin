/**
 * 前端 lint 配置：沿用 Umi 自带工具链（`@umijs/lint`）。
 *
 * 该预设内部使用 `@babel/eslint-parser` + `@umijs/babel-preset-umi`，
 * 因此 TS / TSX 无需额外引入 typescript-eslint 也能解析；
 * 插件只含 react 与 react-hooks，与 Umi 运行时约定一致。
 *
 * 规则取向：只保留能长期维护的最小集，不追求规则数量，也不为了过门禁放宽。
 * 后端（apps/server）与纯 TS 包（packages/*）由 oxlint + oxfmt 负责，见根目录 `.oxlintrc.json`。
 */
module.exports = {
  root: true,
  extends: [require.resolve('@umijs/lint/dist/config/eslint')],
  ignorePatterns: ['dist/', 'src/.umi/', 'src/.umi-production/', '.umi/', 'node_modules/', '**/*.d.ts'],
  rules: {
    /**
     * 用 TS 版规则替代基础版：基础 `no-unused-vars` 不理解 TS 的类型位置，
     * 会把 antd 表格 `render(value, record, index)` 一类「只用到部分参数」的
     * 回调签名误判为未使用。TS 版能正确处理，且保留 `_` 前缀的显式忽略约定。
     */
    'no-unused-vars': 'off',
    '@typescript-eslint/no-unused-vars': [
      'error',
      { args: 'after-used', argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],
    // 函数声明存在提升，先调用后定义是安全的；只对变量与类保留检查。
    '@typescript-eslint/no-use-before-define': ['error', { functions: false }],
    // Hooks 依赖缺失可能引入陈旧闭包，保持告警（不阻断构建）。
    'react-hooks/exhaustive-deps': 'warn',
  },
  overrides: [
    {
      // 配置与脚本文件在 Node 下执行。
      files: ['*.config.js', '.umirc.ts', 'src/**/*.test.ts', 'src/**/*.test.tsx'],
      env: { node: true },
    },
  ],
};
