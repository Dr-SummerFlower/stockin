/**
 * `operation_logs` append-only 日志 SQL。
 *
 * 依据：设计文档 v1.1 §4.2 / §4.5 / §5.2 —— action / target_type /
 * target_id（无外键）/ detail(JSON) / request_id / actor / occurred_at；
 * append-only、不自动清空、不软删、物理删记录后审计链不断；
 * 与业务写**同一事务**（事务入口在 db.ts 的 immediateTransaction）；
 * 时间戳由应用层以 UTC ISO 8601 注入，SQL 内无日期函数。
 *
 * 本类刻意**不提供** update / delete 方法，表级触发器再兜一层硬保护。
 */
import { Action, TARGET_TYPE, type ErrorCode } from '@stockin/shared';
import type { Db } from './db';
import type { OperationLogRow } from './types';

export interface NewOperationLog {
  readonly action: Action;
  readonly targetType: (typeof TARGET_TYPE)[keyof typeof TARGET_TYPE];
  readonly targetId: number | null;
  readonly detail?: unknown;
  readonly requestId: string;
  readonly actor: string;
  /** UTC ISO 8601，来自 lib/today.ts 的 utcNowIso()。 */
  readonly occurredAt: string;
}

export interface OperationLogFilter {
  readonly action?: Action;
  readonly targetType?: string;
  readonly targetId?: number;
  readonly from?: string;
  readonly to?: string;
  readonly limit?: number;
  readonly offset?: number;
}

const SENSITIVE_KEY_PATTERN =
  /^(password|currentPassword|newPassword|passwordHash|salt|token|tokenHash|cookie|remark)$/i;

/**
 * detail 脱敏：与 pino redact 口径一致，避免密码 / Cookie / 备注全文入库。
 * 递归处理数组与对象，敏感键统一替换为 '[REDACTED]'。
 */
export function sanitizeDetail(value: unknown, depth: number = 0): unknown {
  if (depth > 8) {
    return '[TRUNCATED]';
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeDetail(item, depth + 1));
  }
  if (typeof value === 'object' && value !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      result[key] = SENSITIVE_KEY_PATTERN.test(key)
        ? '[REDACTED]'
        : sanitizeDetail(child, depth + 1);
    }
    return result;
  }
  return value;
}

/**
 * B1：筛选条件的唯一组装点。`list()` 与 `count()` 共用，
 * 保证 `total` 与 `items` 的 action / targetType / targetId / from / to 口径完全一致。
 */
function buildLogWhere(filter: OperationLogFilter): { where: string; params: unknown[] } {
  const clauses: string[] = ['1 = 1'];
  const params: unknown[] = [];
  if (filter.action !== undefined) {
    clauses.push('action = ?');
    params.push(filter.action);
  }
  if (filter.targetType !== undefined && filter.targetType !== '') {
    clauses.push('target_type = ?');
    params.push(filter.targetType);
  }
  if (filter.targetId !== undefined) {
    clauses.push('target_id = ?');
    params.push(filter.targetId);
  }
  if (filter.from !== undefined && filter.from !== '') {
    clauses.push('occurred_at >= ?');
    params.push(filter.from);
  }
  if (filter.to !== undefined && filter.to !== '') {
    clauses.push('occurred_at <= ?');
    params.push(filter.to);
  }
  return { where: clauses.join(' AND '), params };
}

/** 分页参数规范化：与 list() 实际生效值一致，供路由回显 limit / offset。 */
export function normalizeLogPaging(filter: OperationLogFilter): {
  limit: number;
  offset: number;
} {
  const limit: number =
    filter.limit !== undefined && Number.isInteger(filter.limit) && filter.limit > 0
      ? Math.min(filter.limit, 1_000)
      : 100;
  const offset: number =
    filter.offset !== undefined && Number.isInteger(filter.offset) && filter.offset >= 0
      ? filter.offset
      : 0;
  return { limit, offset };
}

export class OperationLogRepository {
  constructor(private readonly db: Db) {}

  /** append-only 写入。调用方负责把本调用与业务写放进同一事务。 */
  append(entry: NewOperationLog): number {
    const detail: string =
      entry.detail === undefined ? '{}' : JSON.stringify(sanitizeDetail(entry.detail));
    const result = this.db
      .prepare(
        `INSERT INTO operation_logs
           (action, target_type, target_id, detail, request_id, actor, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.action,
        entry.targetType,
        entry.targetId,
        detail,
        entry.requestId,
        entry.actor,
        entry.occurredAt,
      );
    return Number(result.lastInsertRowid);
  }

  /** 登录失败等场景的便捷入口（action 由调用方显式指定）。 */
  appendFailure(
    action: Action,
    code: ErrorCode,
    requestId: string,
    actor: string,
    occurredAt: string,
  ): number {
    return this.append({
      action,
      targetType: TARGET_TYPE.CREDENTIAL,
      targetId: null,
      detail: { code },
      requestId,
      actor,
      occurredAt,
    });
  }

  /** 时间范围 / 类型 / 记录追溯；裸列与常量比较。 */
  list(filter: OperationLogFilter = {}): readonly OperationLogRow[] {
    const { where, params } = buildLogWhere(filter);
    const { limit, offset } = normalizeLogPaging(filter);
    return this.db
      .prepare(
        `SELECT * FROM operation_logs WHERE ${where}
         ORDER BY occurred_at DESC, id DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as OperationLogRow[];
  }

  /** B1：同筛选条件 COUNT（不再恒为全表总数）。 */
  count(filter: OperationLogFilter = {}): number {
    const { where, params } = buildLogWhere(filter);
    const row = this.db
      .prepare(`SELECT COUNT(*) AS c FROM operation_logs WHERE ${where}`)
      .get(...params) as { c: number } | undefined;
    return row?.c ?? 0;
  }
}
