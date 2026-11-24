/**
 * Workers 恢复暂存端口：用 Durable Object 的 KV 暂存上传的恢复分块。
 *
 * 与 Node 文件版语义一致：
 *  - key 形如 `restore:<batchId>:<seq>`，前缀隔离、便于整批清理。
 *  - 一次性防重放：以 `restore:<batchId>:consumed` 键是否存在为准；DO 单实例
 *    串行执行 + KV put/get 在同一 DO 内的顺序一致性，保证并发下只有一个请求
 *    读到"未消费"并写入消费标记。
 *  - 批次结束 deleteBatch 删除所有分块键（不删 consumed 标记，防重放需长期保留
 *    到 TTL 自然过期；这里用带过期语义的键无法原生支持，故 consumed 标记常驻，
 *    batchId 本身是随机 UUID，不会复用）。
 */
import type { DoStorageLike } from '../../repositories/adapters/do-sqlite.adapter';
import type { RestoreStagingPort } from '../ports';

export interface KvRestoreStagingOptions {
  readonly storage: DoStorageLike;
}

function safeBatchId(batchId: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(batchId)) {
    throw new Error(`[restore-staging] 非法 batchId: ${batchId}`);
  }
  return batchId;
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

export function createKvRestoreStaging(options: KvRestoreStagingOptions): RestoreStagingPort {
  const storage = options.storage;
  const dataKey = (batchId: string, seq: number): string =>
    `restore:${safeBatchId(batchId)}:${seq}`;
  const consumedKey = (batchId: string): string => `restore:${safeBatchId(batchId)}:consumed`;

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
      return seqs.sort((a, b) => a - b);
    },

    async deleteBatch(batchId): Promise<void> {
      const entries = await storage.list({ prefix: `restore:${safeBatchId(batchId)}:` });
      for (const key of entries.keys()) {
        if (!key.endsWith(':consumed')) {
          await storage.delete(key);
        }
      }
    },

    async isConsumed(batchId): Promise<boolean> {
      return (await storage.get(consumedKey(batchId))) !== undefined;
    },

    async consumeBatch(batchId, expiresAtIso): Promise<boolean> {
      if (Date.parse(expiresAtIso) <= Date.now()) {
        return false;
      }
      // 待核实（需在 workerd 实测）：get→put 之间存在 await，若 Cloudflare DO
      // 在该 await 点允许事件交错（即未隐式串行化），两个并发 commit 可能都
      // 读到「未消费」。官方语义是单 DO 实例串行执行，本实现据此假设成立；
      // 若实测不成立，应在 DO 侧用 blockConcurrencyWhile 包裹整个消费流程。
      const key = consumedKey(batchId);
      const already = await storage.get(key);
      if (already !== undefined) {
        return false;
      }
      await storage.put(key, expiresAtIso);
      return true;
    },
  };
}
