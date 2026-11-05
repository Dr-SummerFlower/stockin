/**
 * `meta` 表 SQL：setup_completed 单向 0→1、schema_version、auth_epoch、
 * baseline 与 last_backup_* 元数据。
 *
 * 依据：设计文档 v1.1 §4.2（触发器硬保护 1→非1 与 DELETE，引导不可重入的
 * 唯一权威）、§4.5 / §7.4（baseline 基线快照、init_state）、§5.2（auth_epoch
 * 递增吊销全部会话）。init_state 与 user_version 分字段/分表，互不混淆。
 */
import type { Db } from './db';

export class MetaRepository {
  constructor(private readonly db: Db) {}

  get(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  /** 写入键值；对 setup_completed 的 1→0 / DELETE 由 SQL 触发器硬拦截。 */
  set(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  getInt(key: string, fallback: number = 0): number {
    const raw: string | null = this.get(key);
    if (raw === null || raw.trim() === '') {
      return fallback;
    }
    const parsed: number = Number.parseInt(raw, 10);
    return Number.isSafeInteger(parsed) ? parsed : fallback;
  }

  setInt(key: string, value: number): void {
    if (!Number.isSafeInteger(value)) {
      throw new RangeError('[meta] 整数值非法');
    }
    this.set(key, String(value));
  }

  /** 原子自增并返回新值（auth_epoch 用）。 */
  increment(key: string): number {
    const next: number = this.getInt(key, 0) + 1;
    this.setInt(key, next);
    return next;
  }

  /** init_state（0=待引导，1=已完成）。 */
  initState(): 0 | 1 {
    return this.getInt('setup_completed', 0) === 1 ? 1 : 0;
  }

  setupCompleted(): boolean {
    return this.initState() === 1;
  }

  /** CAS 0→1；重复 setup 返回 false，由 T03b 映射为 409。 */
  markSetupCompleted(): boolean {
    return (
      this.db
        .prepare("UPDATE meta SET value = '1' WHERE key = 'setup_completed' AND value = '0'")
        .run().changes > 0
    );
  }

  authEpoch(): number {
    return this.getInt('auth_epoch', 0);
  }

  schemaVersion(): number {
    return this.getInt('schema_version', 0);
  }

  baseline(): string | null {
    const raw: string | null = this.get('baseline');
    return raw === null || raw.trim() === '' ? null : raw;
  }

  setBaseline(fileName: string): void {
    this.set('baseline', fileName);
  }

  lastBackupAt(): string | null {
    const raw: string | null = this.get('last_backup_at');
    return raw === null || raw.trim() === '' ? null : raw;
  }

  /** 记录备份结果，供应用内空间/失败提示消费。 */
  setLastBackup(atUtc: string, status: 'ok' | 'skipped' | 'failed'): void {
    this.set('last_backup_at', atUtc);
    this.set('last_backup_status', status);
  }
}
