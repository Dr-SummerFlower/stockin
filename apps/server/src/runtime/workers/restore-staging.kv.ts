/**
 * Workers 恢复暂存端口：用 Durable Object 的 KV 暂存上传的恢复分块。
 *
 * 与 Node 文件版语义一致：
 *  - key 形如 `restore:<batchId>:<seq>`，前缀隔离、便于整批清理。
 *  - 一次性防重放：以 `restore:<batchId>:consumed` 键是否存在为准。DO 单实例，
 *    但并发请求可在 await 点交错，故消费动作放进 `blockConcurrencyWhile`
 *    （由组合根注入 `runExclusive`），保证并发下只有一个请求消费成功。
 *  - 标记存活 3 小时（值为 expiresAtIso）：读取时若已过期则直接删除，避免
 *    consumed 标记在 KV 中长期累积。3 小时远长于票据 30 分钟窗口，过期后
 *    任何票据都已失效，清理不会打开重放口子。批次结束 deleteBatch 删除分块键，
 *    未过期的 consumed 标记保留以防重放。
 */
import type { DoStorageLike } from '../../repositories/adapters/do-sqlite.adapter';
import type { RestoreStagingPort } from '../ports';

export interface KvRestoreStagingOptions {
  readonly storage: DoStorageLike;
  /**
   * 关键区串行化（Workers 上由 `ctx.blockConcurrencyWhile` 提供）。
   *
   * 一次性消费是 `get → put` 两步，中间有 await。DO 虽然是单实例，但并发请求
   * 可以在 await 点交错执行，两个 commit 可能都读到「未消费」。把这段放进输入门，
   * 期间不投递其他事件，从而保证只有一个请求消费成功。缺省（测试替身 / 未接线）
   * 退化为直接执行，语义与旧实现一致。
   */
  readonly runExclusive?: <T>(fn: () => Promise<T>) => Promise<T>;
}

function safeBatchId(batchId: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(batchId)) {
    throw new Error(`[restore-staging] 非法 batchId: ${batchId}`);
  }
  return batchId;
}

function dataKey(batchId: string, seq: number): string {
  return `restore:${safeBatchId(batchId)}:${seq}`;
}

function consumedKey(batchId: string): string {
  return `restore:${safeBatchId(batchId)}:consumed`;
}

/** DO KV 读回的值统一转成 Uint8Array。 */
function toBytes(value: unknown): Uint8Array | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (typeof value === 'string') {
    return new TextEncoder().encode(value);
  }
  return null;
}

/** 读回的标记值是否已过期：解不出时间戳一律当作过期，避免坏值永久占位。 */
function markExpired(value: unknown): boolean {
  const bytes = toBytes(value);
  if (bytes === null) {
    return true;
  }
  const expiresAt: number = Date.parse(new TextDecoder().decode(bytes));
  return !Number.isFinite(expiresAt) || expiresAt <= Date.now();
}

export function createKvRestoreStaging(options: KvRestoreStagingOptions): RestoreStagingPort {
  const storage = options.storage;
  const runExclusive: <T>(fn: () => Promise<T>) => Promise<T> =
    options.runExclusive ?? (<T>(fn: () => Promise<T>): Promise<T> => fn());

  return {
    async putChunk(batchId, seq, data): Promise<void> {
      if (!Number.isInteger(seq) || seq < 0) {
        throw new Error(`[restore-staging] 非法 seq: ${seq}`);
      }
      // 端口契约保证 data 是 Uint8Array；复制一份避免调用方复用缓冲区后被篡改。
      const copy = new Uint8Array(data.byteLength);
      copy.set(data);
      await storage.put(dataKey(batchId, seq), copy);
    },

    async readChunk(batchId, seq): Promise<Uint8Array | null> {
      return toBytes(await storage.get(dataKey(batchId, seq)));
    },

    async listChunkSeqs(batchId): Promise<number[]> {
      const entries = await storage.list({ prefix: `restore:${safeBatchId(batchId)}:` });
      const seqs: number[] = [];
      for (const key of entries.keys()) {
        const tail: string = key.slice(`restore:${safeBatchId(batchId)}:`.length);
        if (/^\d+$/.test(tail)) {
          seqs.push(Number.parseInt(tail, 10));
        }
      }
      return seqs.toSorted((a, b) => a - b);
    },

    async deleteBatch(batchId): Promise<void> {
      const entries = await storage.list({ prefix: `restore:${safeBatchId(batchId)}:` });
      for (const key of entries.keys()) {
        // 分块一律删除；consumed 标记只在未过期时保留，过期的一并清掉。
        const consumed: boolean = key.endsWith(':consumed');
        if (!consumed || markExpired(entries.get(key))) {
          await storage.delete(key);
        }
      }
    },

    async isConsumed(batchId): Promise<boolean> {
      const value = await storage.get(consumedKey(batchId));
      if (value === undefined) {
        return false;
      }
      if (markExpired(value)) {
        await storage.delete(consumedKey(batchId));
        return false;
      }
      return true;
    },

    async consumeBatch(batchId, expiresAtIso): Promise<boolean> {
      if (Date.parse(expiresAtIso) <= Date.now()) {
        return false;
      }
      const key = consumedKey(batchId);
      // get→put 之间必须不被打断：放进 DO 输入门（blockConcurrencyWhile）执行，
      // 期间其他事件排队，两个并发 commit 里只有一个能读到「未消费」。
      const attempt = async (): Promise<boolean> => {
        const already = await storage.get(key);
        if (already !== undefined) {
          // 未过期的标记才算重复；过期的直接清掉，让本次消费继续。
          if (!markExpired(already)) {
            return false;
          }
          await storage.delete(key);
        }
        await storage.put(key, expiresAtIso);
        return true;
      };
      return runExclusive(attempt);
    },
  };
}
