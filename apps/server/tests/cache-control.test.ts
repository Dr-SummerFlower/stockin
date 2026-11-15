import { describe, expect, it } from 'vitest';
import { isHashedAsset, isIndexHtmlPath } from '../src/middleware/cache-control';

/**
 * 缓存头判定的纯函数部分。
 *
 * 任务卡 01 切换 Vite 引擎后，产物命名从
 * `umi.<8位hex>.js` 变为 `assets/umi-<8位base64url>.js`，
 * 两套命名都必须被识别为「不可变资源」，否则会丢掉 immutable 缓存。
 */
describe('isHashedAsset 识别带 hash 的静态资源', () => {
  it('Umi webpack 命名（点号分隔 + 纯 hex）', () => {
    expect(isHashedAsset('/umi.bfc5c5f2.js')).toBe(true);
    expect(isHashedAsset('/umi.465c9940.css')).toBe(true);
    expect(isHashedAsset('/p__index.18002071.async.js')).toBe(true);
  });

  it('Umi Vite 命名（连字符分隔 + base64url）', () => {
    expect(isHashedAsset('/assets/umi-BxyOB4sm.js')).toBe(true);
    expect(isHashedAsset('/assets/umi-DhjA78I1.css')).toBe(true);
    expect(isHashedAsset('/assets/index-DFl_-4Wv.js')).toBe(true);
    expect(isHashedAsset('/assets/edit-aq1-uZe1.js')).toBe(true);
  });

  it('非资源路径不误判', () => {
    for (const path of [
      '/',
      '/index.html',
      '/records',
      '/records/2026-11-15',
      '/settings',
      '/api/records',
    ]) {
      expect(isHashedAsset(path)).toBe(false);
    }
  });

  it('短后缀文件名不当作 hash（避免把普通静态名判成不可变）', () => {
    expect(isHashedAsset('/logo.svg')).toBe(false);
    expect(isHashedAsset('/icon-ab.js')).toBe(false);
  });
});

describe('isIndexHtmlPath SPA 文档路径', () => {
  it('根路径、显式 index.html 与深链 fallback 目标', () => {
    expect(isIndexHtmlPath('/')).toBe(true);
    expect(isIndexHtmlPath('/index.html')).toBe(true);
  });

  it('普通 API 与资源路径不是文档', () => {
    expect(isIndexHtmlPath('/api/health')).toBe(false);
    expect(isIndexHtmlPath('/assets/umi-BxyOB4sm.js')).toBe(false);
  });
});
