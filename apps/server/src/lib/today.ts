/**
 * **全服务端唯一读取系统时钟的位置**。
 *
 * 依据：设计文档 v1.1 §4.3「审计时间戳 UTC ISO 8601 文本；SQL 内禁用
 * date('now') / CURRENT_DATE，基准日由应用层注入」、§5.1「domain 零时钟，
 * today 由调用方注入」、§5.2「/api/dashboard 取一次 today」。
 *
 * 其它任何 server 模块都不得使用 `new Date()` / `Date.now()` / `Intl` 取当前时间；
 * 一律调用本模块，保证基准日 TZ 语义与审计时间戳口径唯一。
 */
import { DEFAULT_TZ } from '@stockin/shared';

let serverTimeZone: string = DEFAULT_TZ;

/** 由 bootstrap 在环境解析后注入 TZ。 */
export function configureServerTimeZone(timeZone: string): void {
  if (timeZone.trim() === '') {
    throw new RangeError('[today] TZ 不能为空');
  }
  serverTimeZone = timeZone;
}

/** 返回当前生效的服务器时区。 */
export function currentServerTimeZone(): string {
  return serverTimeZone;
}

/**
 * 服务器本地自然日（YYYY-MM-DD），按配置的 TZ 计算。
 * 使用 `formatToParts` 而非依赖进程 TZ 或 locale 的 toLocaleDateString 组合。
 */
export function serverToday(): string {
  const parts: Intl.DateTimeFormatPart[] = new Intl.DateTimeFormat('en-US', {
    timeZone: serverTimeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const values: Record<string, string> = {};
  for (const part of parts) {
    values[part.type] = part.value;
  }
  const year: string = values.year ?? '1970';
  const month: string = values.month ?? '01';
  const day: string = values.day ?? '01';
  return `${year.padStart(4, '0')}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

/** 审计时间戳：UTC ISO 8601 毫秒精度文本，字典序即时间序。 */
export function utcNowIso(): string {
  return new Date().toISOString();
}

/** N 天之后的 UTC ISO 8601 时间戳（会话双过期用，字典序可直接比较）。 */
export function utcAfterDaysIso(days: number): string {
  if (!Number.isFinite(days)) {
    throw new RangeError('[today] days 必须是有限数字');
  }
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

/** 当前 Unix 秒（仅用于限流窗口等应用层计算，不进 SQL 日期函数）。 */
export function epochSeconds(): number {
  return Math.floor(Date.now() / 1_000);
}
