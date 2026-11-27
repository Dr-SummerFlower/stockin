/**
 * 路由层整数参数解析（唯一实现）。
 *
 * 两种口径，不要混用：
 *  - **严格**（`queryInt` / `parsePositiveIdParam`）：非法值变成 `NaN` / `null`，
 *    由 zod 判 422 或路由回 400。用于有契约约束的列表与详情接口（记录、单据）——
 *    参数拼错必须报错，不能静默拿到「另一页」。
 *  - **容错**（`queryPositiveOrUndefined` / `queryNonNegativeOrUndefined`）：
 *    非法值按「没传」处理，回落服务端默认值。用于大屏 / 日志这类只读聚合接口。
 *
 * 都不使用 `Number.parseInt`：它会把 `1.5`、`20abc` 静默截断成整数。
 * 此前记录侧用 parseInt、单据侧用纯数字校验，同一个拼错参数一边 200 一边 422
 * （AUDIT-07），这里收敛成同一份实现。
 */
import type { Context } from 'hono';

/** 纯十进制非负整数文本判定。 */
function isDigits(raw: string): boolean {
  return /^\d+$/.test(raw);
}

/**
 * 严格解析：未传 / 空串 → `undefined`；非法 → `NaN`（交给 zod 报 422）。
 */
export function queryInt(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  const trimmed: string = raw.trim();
  return isDigits(trimmed) ? Number(trimmed) : Number.NaN;
}

/** 容错解析：非法或非正数一律按「没传」处理。 */
export function queryPositiveOrUndefined(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  const value: number = Number(raw.trim());
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** 容错解析：非法或负数一律按「没传」处理（日志 offset / targetId 用）。 */
export function queryNonNegativeOrUndefined(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  const value: number = Number(raw.trim());
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * 路径 id：必须是纯十进制正整数，否则返回 `null`（路由回 400）。
 * `/api/records/12abc` 不再命中 id=12。
 */
export function parsePositiveIdParam(c: Context, name = 'id'): number | null {
  const raw: string = c.req.param(name) ?? '';
  if (!isDigits(raw)) {
    return null;
  }
  const value: number = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}
