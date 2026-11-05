/**
 * `@stockin/domain` 统一导出面。
 *
 * 全部为框架无关的纯函数：零 IO、零框架、零 `Date.now()` / 任何时钟读取；
 * 运行时只依赖 `@stockin/shared`。基准日 `today` 一律由调用方注入。
 */
export * from './types';
export * from './date';
export * from './fixed';
export * from './shelf-life';
export * from './normalize';
export * from './expiry';
export * from './groups';
export * from './field-state';
export * from './aggregate';
export * from './excel-rules';
