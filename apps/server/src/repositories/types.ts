/**
 * DB 行（snake_case）↔ DTO（camelCase）映射类型与纯映射函数。
 *
 * 依据：设计文档 v1.1 §4.2（6 个 *_src INTEGER，0=USER / 1=AUTO，
 * 与「值是否为空」组合表达 API 三态）、§4.3（可空字段、归一化列）、§5.2
 * 「来源标记落库由 Repository 映射，仅覆盖 6 个联动槽位，不含进货日期」。
 *
 * T02 §⑦-4 继承要求：**SQLite 读出的可空字段统一归一为 null**，
 * 否则八项判重会把 `""` 与 `null` 判为不同。所有映射都必须走 `nullable()`。
 */
import {
  DB_SRC_AUTO,
  decodeFieldSource,
  encodeFieldSource,
  type FieldSource,
  type RecordFields,
  type RecordSources,
  type RecordView,
  type ShelfLifeUnit,
} from '@stockin/shared';
import { classifyExpiry, expiryWindow } from '@stockin/domain';

/** 写操作上下文：时间戳与 requestId 全部由应用层注入（SQL 内无任何日期函数）。 */
export interface WriteContext {
  readonly requestId: string;
  readonly actor: string;
  /** UTC ISO 8601 文本，来自 lib/today.ts 的 utcNowIso()。 */
  readonly occurredAt: string;
}

/** 所有可空 TEXT 统一归一：null / undefined / 空串 / 纯空白 → null。 */
export function nullable(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value.trim() === '') {
    return null;
  }
  return value;
}

export interface RecordRow {
  id: number;
  name: string;
  name_norm: string;
  purchase_date: string;
  production_date: string | null;
  shelf_life_value: number | null;
  shelf_life_unit: string | null;
  expiry_date: string | null;
  spec: string | null;
  spec_norm: string;
  unit_price: number;
  quantity: number;
  amount_cents: number;
  remark: string | null;
  production_date_src: number;
  shelf_life_src: number;
  expiry_date_src: number;
  unit_price_src: number;
  quantity_src: number;
  amount_src: number;
  version: number;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SessionRow {
  id: string;
  token_hash: string;
  account_id: number;
  idle_expires_at: string;
  absolute_expires_at: string;
  revoked: number;
  revoked_reason: string | null;
  auth_epoch: number;
  created_at: string;
  last_seen_at: string;
}

/** 管理员账户（GitHub 登录名唯一，统一小写）。 */
export interface AdminAccountRow {
  id: number;
  github_login: string;
  github_user_id: number | null;
  display_name: string;
  created_at: string;
  last_login_at: string | null;
}

/** 管理员会话：只存 token 的 sha256。 */
export interface AdminSessionRow {
  id: string;
  token_hash: string;
  admin_id: number;
  idle_expires_at: string;
  absolute_expires_at: string;
  revoked: number;
  created_at: string;
  last_seen_at: string;
}

export interface CredentialRow {
  id: number;
  username: string;
  password_hash: string;
  salt: string;
  scrypt_params: string;
  is_initial: number;
  /** 密保问题文本；空串表示未设置。 */
  security_question: string;
  security_answer_salt: string;
  security_answer_hash: string;
  created_at: string;
  updated_at: string;
}

export interface SettingsRow {
  id: number;
  expiry_threshold_days: number;
  shop_name: string;
  logical_backup_interval_days: number;
  physical_backup_interval_days: number;
}

export interface MetaRow {
  key: string;
  value: string;
}

export interface OperationLogRow {
  id: number;
  action: string;
  target_type: string;
  target_id: number | null;
  detail: string | null;
  request_id: string;
  actor: string;
  occurred_at: string;
}

/** 6 个来源位的 DB 形态（INTEGER 0/1）。 */
export interface DbSourceFlags {
  readonly production_date_src: number;
  readonly shelf_life_src: number;
  readonly expiry_date_src: number;
  readonly unit_price_src: number;
  readonly quantity_src: number;
  readonly amount_src: number;
}

function isEmptyText(value: string | null | undefined): boolean {
  return nullable(value) === null;
}

/**
 * 数值列 NOT NULL DEFAULT 0，无法直接表达「空」。
 * 文档 §10.1 裁决 11「空值落 0」，故 `0 且来源位非 AUTO` 视为空；
 * AUTO 槽即使值为 0 仍保留 AUTO，避免覆盖标记丢失。
 */
function isEmptyNumeric(value: number, dbSource: number): boolean {
  return value === 0 && dbSource !== DB_SRC_AUTO;
}

/** DB 行 → API 10 字段（可空字段全部归一为 null）。 */
export function toRecordFields(row: RecordRow): RecordFields {
  return {
    name: row.name,
    purchaseDate: row.purchase_date,
    productionDate: nullable(row.production_date),
    shelfLifeValue: row.shelf_life_value,
    shelfLifeUnit: nullable(row.shelf_life_unit) as ShelfLifeUnit | null,
    expiryDate: nullable(row.expiry_date),
    spec: nullable(row.spec),
    unitPrice: row.unit_price,
    quantity: row.quantity,
    amountCents: row.amount_cents,
    remark: nullable(row.remark),
  };
}

/** DB 6 个 INTEGER 来源位 → API 三态（decodeFieldSource 为唯一真源）。 */
export function toRecordSources(row: RecordRow): RecordSources {
  return {
    productionDateSrc: decodeFieldSource(isEmptyText(row.production_date), row.production_date_src),
    shelfLifeSrc: decodeFieldSource(
      row.shelf_life_value === null || row.shelf_life_unit === null,
      row.shelf_life_src,
    ),
    expiryDateSrc: decodeFieldSource(isEmptyText(row.expiry_date), row.expiry_date_src),
    unitPriceSrc: decodeFieldSource(
      isEmptyNumeric(row.unit_price, row.unit_price_src),
      row.unit_price_src,
    ),
    quantitySrc: decodeFieldSource(
      isEmptyNumeric(row.quantity, row.quantity_src),
      row.quantity_src,
    ),
    amountSrc: decodeFieldSource(isEmptyNumeric(row.amount_cents, row.amount_src), row.amount_src),
  };
}

/** API 三态 → DB 6 个 INTEGER（encodeFieldSource 为唯一真源，EMPTY 落 0）。 */
export function toDbSourceFlags(sources: RecordSources): DbSourceFlags {
  const flag = (source: FieldSource): number => encodeFieldSource(source);
  return {
    production_date_src: flag(sources.productionDateSrc),
    shelf_life_src: flag(sources.shelfLifeSrc),
    expiry_date_src: flag(sources.expiryDateSrc),
    unit_price_src: flag(sources.unitPriceSrc),
    quantity_src: flag(sources.quantitySrc),
    amount_src: flag(sources.amountSrc),
  };
}

/**
 * DB 行 → 记录视图。临期/过期分类一律走 domain 的 expiryWindow/classifyExpiry，
 * **不消费 computeDateGroup 的派生展示字段**（那份固定用默认阈值 30）。
 *
 * @param today 服务器本地自然日，由应用层注入
 * @param thresholdDays 当前生效阈值 X
 */
export function toRecordView(row: RecordRow, today: string, thresholdDays: number): RecordView {
  const d: number | null = expiryWindow(today, nullable(row.expiry_date), thresholdDays);
  return {
    ...toRecordFields(row),
    id: row.id,
    sources: toRecordSources(row),
    nameNorm: row.name_norm,
    specNorm: row.spec_norm,
    deletedAt: nullable(row.deleted_at),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
    remainingDays: d,
    expiryStatus: classifyExpiry(d, thresholdDays),
  };
}
