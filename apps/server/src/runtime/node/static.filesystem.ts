/**
 * Node 运行时：磁盘目录静态托管。
 *
 * 由原 `static.ts` 拆出 —— `@hono/node-server/serve-static` 在 Workers 构建期
 * 即解析失败，必须让它只出现在 Node 侧模块里。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { serveStatic } from '@hono/node-server/serve-static';
import type { MiddlewareHandler } from 'hono';
import { sha256Hex } from '../../lib/crypto';
import type { AppEnv } from '../../types/hono';
import type { IndexDocument } from '../../static';
import type { StaticPort } from '../ports';

/** 默认静态根：从编译产物 dist/*.js 反推 apps/web/dist（绝对路径）。 */
export function defaultStaticRoot(): string {
  return fileURLToPath(new URL('../../web/dist/', pathToFileURL(__filename)));
}

/** 读取 index.html 并生成内容 ETag；产物缺失时给最小可启动兜底页。 */
export function readIndexDocument(staticRoot: string): IndexDocument {
  const file: string = path.join(staticRoot, 'index.html');
  let html: string;
  try {
    html = fs.readFileSync(file, 'utf8');
  } catch {
    html =
      '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>进货统计</title></head><body><div id="root"></div></body></html>';
  }
  return { html, etag: `"${sha256Hex(html).slice(0, 24)}"` };
}

/** 构造磁盘静态托管端口；root 必须是绝对路径。 */
export function createFilesystemStaticPort(staticRoot: string): StaticPort {
  const indexDocument: IndexDocument = readIndexDocument(staticRoot);
  const handler: MiddlewareHandler<AppEnv> = serveStatic({
    root: staticRoot,
  }) as MiddlewareHandler<AppEnv>;
  return {
    indexDocument,
    middleware(): MiddlewareHandler<AppEnv> {
      return handler;
    },
  };
}
