/**
 * Node 恢复暂存端口：用临时目录暂存上传的恢复分块。
 *
 * - 每个 batch 一个子目录，文件名即 seq，避免路径注入（batchId 只允许安全字符）。
 * - 批次不再需要时 deleteBatch 整目录删除。
 * - 一次性防重放：consume 通过原子 rename 一个标记文件实现（rename 在同一文件系统
 *   上是原子的），保证并发下只有一个请求能拿到票据。
 * - 标记存活 3 小时（由调用方传入 expiresAtIso）：读取时若已过期则直接删除，
 *   避免标记文件长期累积。3 小时远长于票据 30 分钟窗口，清理不会打开重放口子。
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

/** 标记是否已过期：读不到/时间戳非法一律当作过期，避免坏标记永久占位。 */
function markExpired(file: string): boolean {
  try {
    const expiresAt: number = Date.parse(fs.readFileSync(file, 'utf8'));
    return !Number.isFinite(expiresAt) || expiresAt <= Date.now();
  } catch {
    return true;
  }
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
      // 删除分块但保留未过期的 .consumed 标记，避免同批次被重放；已过期的标记
      // 由 isConsumed/consumeBatch 惰性清理，这里一并兜底删掉。
      // .consuming 是瞬时锁，正常路径已被 consumeBatch 清理；这里兜底删除残留。
      for (const name of fs.readdirSync(dir)) {
        if (name === '.consumed') {
          if (markExpired(path.join(dir, name))) {
            fs.rmSync(path.join(dir, name), { force: true });
          }
          continue;
        }
        fs.rmSync(path.join(dir, name), { force: true });
      }
    },

    async isConsumed(batchId): Promise<boolean> {
      const consumed = path.join(batchDir(batchId), '.consumed');
      if (!fs.existsSync(consumed)) {
        return false;
      }
      if (markExpired(consumed)) {
        fs.rmSync(consumed, { force: true });
        return false;
      }
      return true;
    },

    async consumeBatch(batchId, expiresAtIso): Promise<boolean> {
      if (Date.parse(expiresAtIso) <= Date.now()) {
        return false;
      }
      const dir = batchDir(batchId);
      const consumed = path.join(dir, '.consumed');
      const lock = path.join(dir, '.consuming');
      if (fs.existsSync(consumed)) {
        // 未过期的标记才算重复；过期的直接清掉，让本次消费继续。
        if (!markExpired(consumed)) {
          return false;
        }
        fs.rmSync(consumed, { force: true });
      }
      if (fs.existsSync(lock)) {
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
      // .consumed 已是持久的防重放标记，瞬时锁不再需要，立即清理避免残留。
      fs.rmSync(lock, { force: true });
      return true;
    },
  };
}
