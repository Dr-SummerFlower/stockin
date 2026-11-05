import { serve } from '@hono/node-server';
import { Hono } from 'hono';

/**
 * 解析监听端口：生产由 PORT 注入，本地开发默认 3000。
 *
 * @param rawPort 环境变量 PORT 的原始字符串
 * @returns 合法的 TCP 端口号
 * @throws 当 PORT 不是 0~65535 的整数时
 */
function resolvePort(rawPort: string | undefined): number {
  const value: string = rawPort ?? '3000';
  const port: number = Number.parseInt(value, 10);

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`[stockin] 非法 PORT 值: ${value}`);
  }

  return port;
}

const app = new Hono();

app.get('/api/health', (c) => {
  return c.json({ status: 'ok' }, 200);
});

const port: number = resolvePort(process.env.PORT);
const server = serve({ fetch: app.fetch, port });

console.info(`[stockin] server listening on http://127.0.0.1:${port}`);

/** 优雅停机：停止接收新连接，等已有请求结束后退出。 */
const shutdown = (): void => {
  server.close(() => {
    process.exit(0);
  });
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
