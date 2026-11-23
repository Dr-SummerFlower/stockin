/**
 * Node 恢复暂存端口：用临时目录暂存上传的恢复分块。
 *
 * - 每个 batch 一个子目录，文件名即 seq，避免路径注入（batchId 只允许安全字符）。
 * - 批次不再需要时 deleteBatch 整目录删除。
 * - 一次性防重放：consume 通过原子 rename 一个标记文件实现（rename 在同一文件系统
 *   上是原子的），保证并发下只有一个请求能拿到票据。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { RestoreStagingPort } from '../ports';

export interface FsRestoreStagingOptions {
  readonly tmpDir: string;
}

/** batchId 只允许 hex / 字母 / 数字 / 连字符，杜绝路径穿越。 */
function safeBatchId(batchId: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(batchId)) {
    throw new Error(`[restore-staging] 非法 batchId: ${batchId}`);
  }
  return batchId;
}

export function createFilesystemRestoreStaging(
  options: FsRestoreStagingOptions,
): RestoreStagingPort {
  const root: string = path.join(options.tmpDir, 'restore-staging');
  fs.mkdirSync(root, { recursive: true });

  const batchDir = (batchId: string): string => path.join(root, safeBatchId(batchId));
  const chunkPath = (batchId: string, seq: number): string => {
    if (!Number.isInteger(seq) || seq < 0) {
      throw new Error(`[restore-staging] 非法 seq: ${seq}`);
    }
    return path.join(batchDir(batchId), `${seq}.chunk`);
  };

  return {
    async putChunk(batchId, seq, data): Promise<void> {
      const dir = batchDir(batchId);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(chunkPath(batchId, seq), data);
    },

    async readChunk(batchId, seq): Promise<Uint8Array | null> {
      const file = chunkPath(batchId, seq);
      if (!fs.existsSync(file)) {
        return null;
      }
      return new Uint8Array(fs.readFileSync(file));
    },

    async listChunkSeqs(batchId): Promise<number[]> {
      const dir = batchDir(batchId);
      if (!fs.existsSync(dir)) {
        return [];
      }
      return fs
        .readdirSync(dir)
        .filter((name) => name.endsWith('.chunk'))
        .map((name) => Number.parseInt(name.slice(0, -'.chunk'.length), 10))
        .filter((n) => Number.isInteger(n))
        .sort((a, b) => a - b);
    },

    async deleteBatch(batchId): Promise<void> {
      const dir = batchDir(batchId);
      if (!fs.existsSync(dir)) {
        return;
      }
      // 保留 .consumed 标记：与 Workers KV 版一致，batchId 的防重放需持续到
      // 时间窗口自然过期；删除分块但保留消费记录，避免同批次被重放。
      for (const name of fs.readdirSync(dir)) {
        if (name === '.consumed' || name === '.consuming') {
          continue;
        }
        fs.rmSync(path.join(dir, name), { force: true });
      }
    },

    async consumeBatch(batchId, expiresAtIso): Promise<boolean> {
      if (Date.parse(expiresAtIso) <= Date.now()) {
        return false;
      }
      const dir = batchDir(batchId);
      const consumed = path.join(dir, '.consumed');
      const lock = path.join(dir, '.consuming');
      if (fs.existsSync(consumed) || fs.existsSync(lock)) {
        return false;
      }
      fs.mkdirSync(dir, { recursive: true });
      try {
        // 独占创建锁文件：O_EXCL 保证只有一个调用者成功。
        const fd = fs.openSync(lock, 'wx');
        fs.closeSync(fd);
      } catch {
        return false;
      }
      fs.writeFileSync(consumed, expiresAtIso, 'utf8');
      return true;
    },
  };
}
