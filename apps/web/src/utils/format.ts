/**
 * 全站展示格式化工具。
 *
 * 依据：设计文档 v1.1 §2.4「展示格式」——全站 `YYYY-MM-DD`；
 * 金额千分位 + 2 位（展示态带 ¥、录入态不带）；保质期「数值 + 单位」。
 * 单位文案一律取 `@stockin/shared` 的 `SHELF_LIFE_UNIT_LABELS`（Excel「12个月」唯一真源），
 * 定点整数 ↔ 文本一律复用 `@stockin/domain` 的 `formatFixed` / `parseFixed`，不重新实现。
 */
import {
  DATE_FORMAT,
  SCALE,
  SHELF_LIFE_UNIT_LABELS,
  type RecordFilter,
  type ShelfLifeUnit,
} from '@stockin/shared';
import { formatFixed } from '@stockin/domain';

/** 全站日期展示格式常量（来自 shared，避免另写一份）。 */
export const DISPLAY_DATE_FORMAT: string = DATE_FORMAT;

/** YYYY-MM-DD 合法性（仅格式，日历合法性由 domain/date.ts 负责）。 */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** 日期展示：空值显示占位符，其余原样输出 YYYY-MM-DD。 */
export function formatDate(value: string | null | undefined): string {
  if (value === null || value === undefined || value.trim() === '') {
    return '—';
  }
  return DATE_PATTERN.test(value) ? value : value;
}

/** 是否为 YYYY-MM-DD 文本。 */
export function isDateString(value: string): boolean {
  return DATE_PATTERN.test(value);
}

/**
 * 服务器容器固定 `TZ=Asia/Shanghai`（UTC+8，无夏令时），但审计时间戳统一存 UTC ISO 8601。
 * 展示必须显式换算成北京时间，不能依赖浏览器本地时区（手机可能不在东八区）。
 */
const CHINA_TZ_OFFSET_MS = 8 * 60 * 60 * 1000;
const HAS_TIMEZONE = /(?:[Zz]|[+-]\d{2}:\d{2})$/;

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/** UTC ISO 文本 → 偏移到北京时间后的 Date（用 getUTC* 读取即为北京时间的字段）。 */
function toChinaDate(iso: string): Date | null {
  const normalized: string = HAS_TIMEZONE.test(iso) ? iso : `${iso}Z`;
  const parsed: Date = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return new Date(parsed.getTime() + CHINA_TZ_OFFSET_MS);
}

/** 北京时间的自然日 YYYY-MM-DD（用于「今天 / 昨天」判断）。 */
function chinaDateKey(date: Date): string {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

/**
 * UTC ISO 8601 时间戳 → 北京时间 `YYYY-MM-DD HH:mm:ss`。
 * 无时区后缀的文本按「已经是本地时间」处理，沿用纯截取，避免二次 +8。
 */
export function formatDateTime(iso: string | null | undefined): string {
  if (iso === null || iso === undefined || iso === '') {
    return '—';
  }
  if (!HAS_TIMEZONE.test(iso)) {
    const match: RegExpExecArray | null = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/.exec(iso);
    return match === null ? iso : `${match[1]} ${match[2]}`;
  }
  const local: Date | null = toChinaDate(iso);
  if (local === null) {
    return iso;
  }
  return `${chinaDateKey(local)} ${pad2(local.getUTCHours())}:${pad2(local.getUTCMinutes())}:${pad2(local.getUTCSeconds())}`;
}

/** 相对时间：今天 / 昨天 / MM-DD + 时分，全部按北京时间。 */
export function formatRelativeDateTime(iso: string | null | undefined): string {
  if (iso === null || iso === undefined || iso === '') {
    return '—';
  }
  const local: Date | null = toChinaDate(iso);
  if (local === null) {
    return formatDateTime(iso);
  }
  const time: string = `${pad2(local.getUTCHours())}:${pad2(local.getUTCMinutes())}`;
  const nowChina: Date = new Date(Date.now() + CHINA_TZ_OFFSET_MS);
  const key: string = chinaDateKey(local);
  if (key === chinaDateKey(nowChina)) {
    return `今天 ${time}`;
  }
  if (key === chinaDateKey(new Date(nowChina.getTime() - 86_400_000))) {
    return `昨天 ${time}`;
  }
  return `${key.slice(5)} ${time}`;
}

/** 北京时间 `HH:mm`，用于「更新于 18:30」这类当次刷新的时间点。 */
export function formatClock(iso: string | null | undefined): string {
  if (iso === null || iso === undefined || iso === '') {
    return '—';
  }
  const local: Date | null = toChinaDate(iso);
  if (local === null) {
    return '—';
  }
  return `${pad2(local.getUTCHours())}:${pad2(local.getUTCMinutes())}`;
}

/** 文件大小：B → KB / MB，避免给普通人看「12,345 B」。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return '—';
  }
  if (bytes < 1024) {
    return `${formatCount(bytes)} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * 备份触发原因（服务端 `BackupMeta.reason` 内部标记）→ 界面展示文案。
 * 取值与 apps/server 的全部写入点一一对应：
 * manual(设置页立即备份) / scheduled-daily(每日定时) / pre-import(导入前) /
 * post-setup-baseline(首次账号设置完成后的基准备份) / pre-migration(结构升级前) /
 * pre-reset-credentials(重置登录凭据前)。服务端新增标记时须同步此表。
 */
const BACKUP_REASON_TEXT: Readonly<Record<string, string>> = {
  manual: '手动备份',
  'scheduled-daily': '每日自动备份',
  'pre-import': '导入前自动备份',
  'post-setup-baseline': '首次设置后自动备份',
  'pre-migration': '升级前自动备份',
  'pre-reset-credentials': '重置账密前自动备份',
  // 兼容早期或外部写入的标记，避免历史备份文件显示英文。
  baseline: '基准备份',
  startup: '启动时备份',
};

/** 未识别标记统一回落为中文，禁止把服务端英文原值显示到界面上。 */
export function describeBackupReason(reason: string | null | undefined): string {
  if (reason === null || reason === undefined || reason.trim() === '') {
    return '例行备份';
  }
  return BACKUP_REASON_TEXT[reason] ?? '系统自动备份';
}

/** 千分位分隔（作用于不含小数的整数文本）。 */
export function groupThousands(intText: string): string {
  const negative: boolean = intText.startsWith('-');
  const digits: string = negative ? intText.slice(1) : intText;
  const grouped: string = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return negative ? `-${grouped}` : grouped;
}

/** 定点整数 → 带千分位的小数文本（金额展示态）。 */
export function formatMoney(cents: number, withSymbol: boolean = true): string {
  const plain: string = formatFixed(Math.trunc(cents), SCALE.AMOUNT_CENTS);
  const dot: number = plain.indexOf('.');
  const intPart: string = dot === -1 ? plain : plain.slice(0, dot);
  const fracPart: string = dot === -1 ? '' : plain.slice(dot);
  const text: string = `${groupThousands(intPart)}${fracPart}`;
  return withSymbol ? `¥${text}` : text;
}

/** 金额录入态：不带 ¥、不带千分位、固定 2 位小数（供输入框初值）。 */
export function formatMoneyInput(cents: number): string {
  return formatFixed(Math.trunc(cents), SCALE.AMOUNT_CENTS);
}

/** 单价展示（×1e4 定点整数 → 4 位小数文本）。 */
export function formatUnitPrice(scaled: number): string {
  return formatFixed(Math.trunc(scaled), SCALE.UNIT_PRICE);
}

/** 单价展示（去尾零）：`34.8000 → 34.8`，用于卡片等「念给人听」的位置。 */
export function formatUnitPriceShort(scaled: number): string {
  const text: string = formatUnitPrice(scaled);
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
}

/** 数量展示（×1e3 定点整数 → 3 位小数文本）。 */
export function formatQuantity(scaled: number): string {
  return formatFixed(Math.trunc(scaled), SCALE.QUANTITY);
}

/**
 * 数量展示（去掉无意义的尾零）：`6.000 → 6`、`2.500 → 2.5`。
 * 单据合计、品种件数这类「念给人听」的位置用它，表格列仍用 formatQuantity 保持对齐。
 */
export function formatQuantityShort(scaled: number): string {
  const text: string = formatQuantity(scaled);
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
}

/** 整数（笔数 / 种类数 / 数量汇总）千分位展示。 */
export function formatCount(value: number): string {
  return groupThousands(String(Math.trunc(value)));
}

/** 保质期「数值 + 单位」：单位文案来自 shared 唯一真源（如 "12个月"）。 */
export function formatShelfLife(
  value: number | null | undefined,
  unit: ShelfLifeUnit | null | undefined,
): string {
  if (value === null || value === undefined || unit === null || unit === undefined) {
    return '—';
  }
  return `${value}${SHELF_LIFE_UNIT_LABELS[unit]}`;
}

/**
 * 下拉单字单位标签（**仅展示层**使用）。
 * 绝不修改 shared 的 `SHELF_LIFE_UNIT_LABELS`，避免打断「导出→导入」闭环。
 * 提交与 Excel 列文案仍走 `SHELF_LIFE_UNIT_LABELS` / `formatShelfLife`。
 */
export const SHORT_UNIT_LABELS: Readonly<Record<ShelfLifeUnit, string>> = {
  day: '天',
  month: '月',
  year: '年',
};

/** 剩余天数文案：临期 ≥0，过期 <0。 */
export function formatRemainingDays(days: number): string {
  if (days < 0) {
    return `已过期 ${Math.abs(days)} 天`;
  }
  return `剩余 ${days} 天`;
}

/** 已应用筛选条件的可移除标签（FilterBar 与导出面板共用同一份描述）。 */
export interface AppliedFilterChip {
  /** 对应的 RecordFilter 字段，移除时把该字段置 undefined。 */
  readonly key: keyof RecordFilter;
  readonly label: string;
}

const EXPIRY_STATUS_TEXT: Readonly<Record<string, string>> = {
  near: '临期',
  expired: '已过期',
  none: '正常',
};

/**
 * 把 RecordFilter 里真正生效的条件描述成 chips。
 * 分页与排序不属于「筛选条件」，刻意不展示。
 */
export function describeRecordFilter(filter: RecordFilter): AppliedFilterChip[] {
  const chips: AppliedFilterChip[] = [];
  const push = (key: keyof RecordFilter, label: string): void => {
    chips.push({ key, label });
  };
  if (filter.name !== undefined && filter.name !== '') {
    push('name', `商品名称：${filter.name}`);
  }
  if (filter.spec !== undefined && filter.spec !== '') {
    push('spec', `规格：${filter.spec}`);
  }
  if (filter.expiryStatus !== undefined) {
    push('expiryStatus', EXPIRY_STATUS_TEXT[filter.expiryStatus] ?? '状态未知');
  }
  if (filter.purchaseDateFrom !== undefined && filter.purchaseDateFrom !== '') {
    push('purchaseDateFrom', `进货日期起：${filter.purchaseDateFrom}`);
  }
  if (filter.purchaseDateTo !== undefined && filter.purchaseDateTo !== '') {
    push('purchaseDateTo', `进货日期止：${filter.purchaseDateTo}`);
  }
  if (filter.expiryDateFrom !== undefined && filter.expiryDateFrom !== '') {
    push('expiryDateFrom', `到期日期起：${filter.expiryDateFrom}`);
  }
  if (filter.expiryDateTo !== undefined && filter.expiryDateTo !== '') {
    push('expiryDateTo', `到期日期止：${filter.expiryDateTo}`);
  }
  return chips;
}
