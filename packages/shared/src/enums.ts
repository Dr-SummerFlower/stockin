/**
 * 全项目共享枚举、槽位定义与编码映射。
 *
 * 依据：设计文档 v1.1 §2.4 BR-1、§4.2（来源位 6 个 INTEGER，0=USER / 1=AUTO）、
 * §10.1 裁决 14（API 三态 EMPTY/AUTO/MANUAL，仅覆盖 6 个联动槽位、不含进货日期）。
 * 禁止在此文件引入任何 IO 或框架依赖。
 */

/** 保质期单位：存储与 API 统一使用英文短码。 */
export const ShelfLifeUnit = {
  DAY: 'day',
  MONTH: 'month',
  YEAR: 'year',
} as const;
export type ShelfLifeUnit = (typeof ShelfLifeUnit)[keyof typeof ShelfLifeUnit];

export const SHELF_LIFE_UNITS: readonly ShelfLifeUnit[] = [
  ShelfLifeUnit.DAY,
  ShelfLifeUnit.MONTH,
  ShelfLifeUnit.YEAR,
];

/**
 * 保质期单位中文标签，是 Excel「数值 + 单位」文案的唯一来源。
 * 文档 §4.3 / §10.1 裁决 18 的导出样例为 `"12个月"`，故 MONTH 标签必须是 `'个月'`。
 */
export const SHELF_LIFE_UNIT_LABELS: Readonly<Record<ShelfLifeUnit, string>> = {
  day: '天',
  month: '个月',
  year: '年',
};

/**
 * 中英文单位标签 → 短码，用于解析 `"12个月"` 一类单元格。
 * 必须与 SHELF_LIFE_UNIT_LABELS 形成双向闭环，否则导出的文件无法被导入链解析；
 * 额外收录单字/带「个」/英文简写以兼容手工编辑的单元格。
 */
export const SHELF_LIFE_UNIT_BY_LABEL: Readonly<Record<string, ShelfLifeUnit>> = {
  天: ShelfLifeUnit.DAY,
  个天: ShelfLifeUnit.DAY,
  日: ShelfLifeUnit.DAY,
  月: ShelfLifeUnit.MONTH,
  个月: ShelfLifeUnit.MONTH,
  年: ShelfLifeUnit.YEAR,
  个年: ShelfLifeUnit.YEAR,
  day: ShelfLifeUnit.DAY,
  days: ShelfLifeUnit.DAY,
  d: ShelfLifeUnit.DAY,
  month: ShelfLifeUnit.MONTH,
  months: ShelfLifeUnit.MONTH,
  mo: ShelfLifeUnit.MONTH,
  year: ShelfLifeUnit.YEAR,
  years: ShelfLifeUnit.YEAR,
  y: ShelfLifeUnit.YEAR,
};

/** 字段来源三态（API 层）。 */
export const FieldSource = {
  EMPTY: 'EMPTY',
  AUTO: 'AUTO',
  MANUAL: 'MANUAL',
} as const;
export type FieldSource = (typeof FieldSource)[keyof typeof FieldSource];

/** DB 来源位列编码：文档 §4.2「6 个 INTEGER（0=USER 1=AUTO）」。 */
export const DB_SRC_USER = 0;
export const DB_SRC_AUTO = 1;
export type DbSourceFlag = typeof DB_SRC_USER | typeof DB_SRC_AUTO;

/**
 * 三态由「值是否为空」与 DB 来源位组合表达（文档 §4.2 原文口径）。
 * 值为空恒为 EMPTY；值非空时 1=AUTO，0=MANUAL(USER)。
 *
 * @param valueIsEmpty 该槽位的值列是否为空
 * @param dbSource DB 中存储的 INTEGER 来源位
 */
export function decodeFieldSource(valueIsEmpty: boolean, dbSource: number): FieldSource {
  if (valueIsEmpty) {
    return FieldSource.EMPTY;
  }
  return dbSource === DB_SRC_AUTO ? FieldSource.AUTO : FieldSource.MANUAL;
}

/**
 * 三态 → DB 来源位。EMPTY 落 0（值列由调用方写空，来源位不单独表达 EMPTY）。
 *
 * @param source API 三态
 */
export function encodeFieldSource(source: FieldSource): DbSourceFlag {
  return source === FieldSource.AUTO ? DB_SRC_AUTO : DB_SRC_USER;
}

/** 6 个联动槽位（不含进货日期，文档 §10.1 裁决 14）。 */
export const LINKAGE_SLOTS = [
  'productionDate',
  'shelfLife',
  'expiryDate',
  'unitPrice',
  'quantity',
  'amount',
] as const;
export type LinkageSlot = (typeof LINKAGE_SLOTS)[number];

export const DATE_GROUP_SLOTS = ['productionDate', 'shelfLife', 'expiryDate'] as const;
export type DateGroupSlot = (typeof DATE_GROUP_SLOTS)[number];

export const AMOUNT_GROUP_SLOTS = ['unitPrice', 'quantity', 'amount'] as const;
export type AmountGroupSlot = (typeof AMOUNT_GROUP_SLOTS)[number];

/** 判断槽位属于日期组还是金额组。 */
export function groupOfSlot(slot: LinkageSlot): 'date' | 'amount' {
  return (DATE_GROUP_SLOTS as readonly string[]).includes(slot) ? 'date' : 'amount';
}

/**
 * 操作日志 action（append-only）。
 *
 * 合规口径（网络安全法第 21 条 / 等保 2.0 安全审计）：只保留
 * **身份鉴别、访问控制、不可逆或批量操作、系统维护**四类可审计事件。
 * 日常增删改（RECORD_CREATE / UPDATE / DELETE）、模板下载、数据导出与
 * 退出登录不再产生审计记录 —— 记录行自身已有创建/更新时间与来源位，
 * 退出登录不构成安全事件。历史行仍在库内，前端映射保留兼容。
 */
export const Action = {
  LOGIN: 'LOGIN',
  LOGIN_FAILED: 'LOGIN_FAILED',
  SETUP_COMPLETE: 'SETUP_COMPLETE',
  RECORD_BATCH_DELETE: 'RECORD_BATCH_DELETE',
  RECORD_RESTORE: 'RECORD_RESTORE',
  RECORD_PURGE: 'RECORD_PURGE',
  EXCEL_IMPORT: 'EXCEL_IMPORT',
  SETTINGS_UPDATE: 'SETTINGS_UPDATE',
  BACKUP_CREATE: 'BACKUP_CREATE',
  BACKUP_RESTORE: 'BACKUP_RESTORE',
  CREDENTIALS_RESET: 'CREDENTIALS_RESET',
  PASSWORD_CHANGE: 'PASSWORD_CHANGE',
  SECURITY_UPDATE: 'SECURITY_UPDATE',
  PASSWORD_RESET: 'PASSWORD_RESET',
  /** 管理员（系统维护身份）侧的鉴别与访问控制事件。 */
  ADMIN_LOGIN: 'ADMIN_LOGIN',
  ADMIN_LOGIN_FAILED: 'ADMIN_LOGIN_FAILED',
  ADMIN_BACKUP_DOWNLOAD: 'ADMIN_BACKUP_DOWNLOAD',
  ADMIN_DATA_EXPORT: 'ADMIN_DATA_EXPORT',
  ADMIN_AUDIT_EXPORT: 'ADMIN_AUDIT_EXPORT',
  ADMIN_OWNER_RESET: 'ADMIN_OWNER_RESET',
} as const;
export type Action = (typeof Action)[keyof typeof Action];

/** 操作日志 target_type。 */
export const TARGET_TYPE = {
  RECORD: 'record',
  CREDENTIAL: 'credential',
  SETTINGS: 'settings',
  SESSION: 'session',
  BACKUP: 'backup',
  ADMIN: 'admin',
  NONE: 'none',
} as const;
export type TargetType = (typeof TARGET_TYPE)[keyof typeof TARGET_TYPE];

/** HTTP 状态白名单（文档 §3.5：严格限定这 10 个）。 */
export const HTTP_STATUS = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNPROCESSABLE_ENTITY: 422,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
} as const;
export type HttpStatus = (typeof HTTP_STATUS)[keyof typeof HTTP_STATUS];

export const HTTP_STATUS_WHITELIST: readonly HttpStatus[] = [
  HTTP_STATUS.BAD_REQUEST,
  HTTP_STATUS.UNAUTHORIZED,
  HTTP_STATUS.FORBIDDEN,
  HTTP_STATUS.NOT_FOUND,
  HTTP_STATUS.CONFLICT,
  HTTP_STATUS.PAYLOAD_TOO_LARGE,
  HTTP_STATUS.UNPROCESSABLE_ENTITY,
  HTTP_STATUS.TOO_MANY_REQUESTS,
  HTTP_STATUS.INTERNAL_SERVER_ERROR,
  HTTP_STATUS.SERVICE_UNAVAILABLE,
];

export function isAllowedHttpStatus(status: number): status is HttpStatus {
  return (HTTP_STATUS_WHITELIST as readonly number[]).includes(status);
}

/** 错误码分段前缀（文档 §3.5）。 */
export const ERROR_SEGMENT = {
  AUTH: 'AUTH',
  VALID: 'VALID',
  RECORD: 'RECORD',
  EXCEL: 'EXCEL',
  COMMON: 'COMMON',
} as const;
export type ErrorSegment = (typeof ERROR_SEGMENT)[keyof typeof ERROR_SEGMENT];
