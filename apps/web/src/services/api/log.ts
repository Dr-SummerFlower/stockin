/**
 * 操作日志 API 与展示层摘要。
 *
 * `operation_logs` 为只追加审计表，DB 行保持 snake_case 原样返回。
 * B1：`total` 是按同筛选条件计数，并回显实际生效的 `limit / offset`。
 * B5：`detail` 由服务端解析成结构化对象，前端不再 JSON.parse。
 *
 * 展示口径：界面不出现裸 JSON，也不出现工程黑话；每条日志压成一句简洁中文摘要，
 * 排查字段换成中文标签 + 用途说明收进「技术信息」区，完整值仍可复制。
 * 服务端枚举一律中文映射，未知值回落中性中文，绝不把原始枚举直出。
 * 措辞保持中性书面语，不使用问句、第一人称或劝导语气。只读翻译层，不改 API 契约。
 */
import { request } from '../request';
import { ACTION_LABELS, TARGET_TYPE_LABELS } from '../../constants/routes';
import { describeBackupReason } from '../../utils/format';

/** `operation_logs` 行的只读视图。 */
export interface OperationLogEntry {
  readonly id: number;
  readonly action: string;
  readonly target_type: string;
  readonly target_id: number | null;
  readonly detail: Record<string, unknown> | null;
  readonly request_id: string;
  readonly actor: string;
  readonly occurred_at: string;
}

export interface OperationLogPage {
  readonly items: readonly OperationLogEntry[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

export interface OperationLogQuery {
  readonly action?: string;
  readonly targetType?: string;
  readonly targetId?: number;
  /** YYYY-MM-DD 或完整 UTC ISO 文本；服务端会按北京时间换算成当日边界。 */
  readonly from?: string;
  readonly to?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export function listOperationLogs(query: OperationLogQuery = {}): Promise<OperationLogPage> {
  return request<OperationLogPage>('/api/operation-logs', {
    query: {
      action: query.action,
      targetType: query.targetType,
      targetId: query.targetId,
      from: query.from,
      to: query.to,
      limit: query.limit,
      offset: query.offset,
    },
  });
}

/** 技术信息条目：中文标签、完整值、用途说明。 */
export interface LogTechnicalField {
  readonly label: string;
  readonly value: string;
  readonly hint: string;
}

/** detail 原始键 → 中文标签；未命中的键统一归为「补充说明」，不把英文键直出。 */
const DETAIL_FIELD_LABELS: Readonly<Record<string, string>> = {
  username: '登录账号',
  fileName: '导入文件',
  totalRows: '表格总行数',
  acceptedRows: '通过行数',
  rejectedRows: '未通过行数',
  issueCount: '问题条数',
  durationMs: '本次耗时',
  requestId: '操作编号',
  ids: '涉及的记录编号',
  deleted: '移入回收站条数',
  restored: '恢复条数',
  purged: '彻底删除条数',
  batch: '是否批量操作',
  expiryThresholdDays: '调整后的临期阈值',
  reason: '备份触发方式',
  status: '备份结果',
  file: '备份文件名',
  filter: '导出筛选条件',
};

const DETAIL_FIELD_HINTS: Readonly<Record<string, string>> = {
  fileName: '本次导入的文件名',
  ids: '本次操作涉及的记录编号',
  durationMs: '本次操作耗时',
  expiryThresholdDays: '保存后的临期阈值',
  filter: '本次导出的筛选条件',
  file: '服务器上的备份文件名',
  reason: '本次备份由何种操作触发',
  status: '本次备份结果',
};

/** 导出筛选条件里的字段 → 中文名（只取后端实际支持的 7 项）。 */
const FILTER_FIELD_LABELS: Readonly<Record<string, string>> = {
  name: '商品名称',
  spec: '规格',
  expiryStatus: '到期状态',
  purchaseDateFrom: '进货起始日期',
  purchaseDateTo: '进货截止日期',
  expiryDateFrom: '到期起始日期',
  expiryDateTo: '到期截止日期',
};

const EXPIRY_STATUS_TEXT: Readonly<Record<string, string>> = {
  near: '临期',
  expired: '已过期',
  none: '正常',
};

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function asIdList(value: unknown): string {
  if (!Array.isArray(value)) {
    return '';
  }
  const ids: string[] = value
    .filter((item: unknown): item is number => typeof item === 'number' && Number.isInteger(item))
    .map((item: number): string => `#${item}`);
  return ids.join('、');
}

function filterParts(value: unknown): readonly string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return [];
  }
  const filter = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const [key, label] of Object.entries(FILTER_FIELD_LABELS)) {
    const raw: unknown = filter[key];
    if (raw === undefined || raw === null || raw === '') {
      continue;
    }
    const text: string =
      key === 'expiryStatus' && typeof raw === 'string'
        ? (EXPIRY_STATUS_TEXT[raw] ?? '状态未知')
        : String(raw);
    parts.push(`${label}：${text}`);
  }
  return parts;
}

function describeFilterBrief(value: unknown): string {
  const parts: readonly string[] = filterParts(value);
  return parts.length === 0 ? '' : `（${parts.join('、')}）`;
}

/**
 * 把一条日志压成一句简洁中文摘要，取代原来的裸 JSON。
 * 规则按 action 分派；detail 为空时退回通用文案，绝不把 JSON 直接抛给界面。
 */
export function summarizeLogEntry(entry: OperationLogEntry): string {
  const detail: Record<string, unknown> = entry.detail ?? {};
  const get = (key: string): unknown => detail[key];
  const number = (key: string): number | null => asNumber(get(key));
  const text = (key: string): string | null => asText(get(key));
  const target: string = entry.target_id === null ? '' : `（#${entry.target_id}）`;
  const source: string = text('fileName') ?? 'Excel';

  switch (entry.action) {
    case 'RECORD_CREATE':
      return `新增进货记录 1 条${target}`;
    case 'RECORD_UPDATE':
      return `修改进货记录 1 条${target}`;
    case 'RECORD_DELETE':
      return `移入回收站 1 条${target}，可恢复`;
    case 'RECORD_RESTORE': {
      const restored: number | null = number('restored');
      return restored === null
        ? `恢复记录 1 条${target}`
        : `批量恢复记录 ${restored} 条`;
    }
    case 'RECORD_PURGE': {
      const purged: number | null = number('purged');
      return purged === null
        ? `彻底删除 1 条${target}，不可恢复`
        : `彻底删除 ${purged} 条，不可恢复`;
    }
    case 'RECORD_BATCH_DELETE':
      return `批量移入回收站 ${number('deleted') ?? 0} 条，可恢复`;
    case 'EXCEL_IMPORT': {
      const accepted: number | null = number('acceptedRows');
      const rejected: number | null = number('rejectedRows');
      const issues: number | null = number('issueCount');
      if (accepted !== null || rejected !== null) {
        const tail: string =
          rejected !== null && rejected > 0 ? `，未通过 ${rejected} 行` : '，全部通过校验';
        return `导入 ${source}：通过 ${accepted ?? 0} 行${tail}`;
      }
      if (issues !== null && issues > 0) {
        return `导入 ${source} 失败：${issues} 个问题`;
      }
      return '导入 Excel 文件';
    }
    case 'EXCEL_EXPORT': {
      const brief: string = describeFilterBrief(get('filter'));
      return brief === '' ? '导出全部进货记录' : `按筛选条件导出进货记录${brief}`;
    }
    case 'EXCEL_TEMPLATE':
      return '下载 Excel 导入模板';
    case 'SETTINGS_UPDATE': {
      const days: number | null = number('expiryThresholdDays');
      return days === null ? '修改临期阈值设置' : `临期阈值调整为 ${days} 天`;
    }
    case 'BACKUP_CREATE': {
      const reason: string = describeBackupReason(text('reason'));
      const status: string | null = text('status');
      if (status === 'skipped') {
        return `${reason}已跳过：磁盘空间不足`;
      }
      if (status === 'failed') {
        return `${reason}失败`;
      }
      return `${reason}完成`;
    }
    case 'BACKUP_RESTORE':
      return '从备份恢复数据';
    case 'LOGIN':
      return '登录系统';
    case 'LOGIN_FAILED':
      return '登录失败';
    case 'LOGOUT':
      return '退出登录';
    case 'SETUP_COMPLETE':
      return '完成首次账号设置';
    case 'CREDENTIALS_RESET':
      return '重置登录凭据';
    default: {
      const action: string = ACTION_LABELS[entry.action] ?? '其他操作';
      return `执行：${action}`;
    }
  }
}

/** 单个原始字段值的可读化；对象/数组不直接 JSON.stringify 成一串代码。 */
function describeDetailValue(key: string, value: unknown): string {
  if (value === null || value === undefined) {
    return '—';
  }
  if (key === 'ids') {
    return asIdList(value) === '' ? '—' : asIdList(value);
  }
  if (key === 'filter') {
    const parts: readonly string[] = filterParts(value);
    return parts.length === 0 ? '无（全部记录）' : parts.join('、');
  }
  if (key === 'reason') {
    return describeBackupReason(asText(value));
  }
  if (key === 'status') {
    const status: string | null = asText(value);
    if (status === 'ok') return '成功';
    if (status === 'skipped') return '已跳过';
    if (status === 'failed') return '失败';
    return status === null ? '—' : '结果未知';
  }
  if (key === 'batch') {
    return value === true ? '是' : '否';
  }
  if (key === 'durationMs') {
    const ms: number | null = asNumber(value);
    return ms === null ? '—' : `${ms} 毫秒`;
  }
  if (typeof value === 'string') {
    return value === '' ? '—' : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return asIdList(value) === '' ? '—' : asIdList(value);
  }
  if (typeof value === 'object') {
    const parts: readonly string[] = filterParts(value);
    return parts.length === 0 ? '—' : parts.join('、');
  }
  return '—';
}

/**
 * 排查用的技术信息：标签换成中文、附用途说明，默认收在折叠区。
 * 值一律完整展示，供鼠标拖拽或手机长按选取，不截断、不设复制按钮。
 */
export function getLogTechnicalFields(entry: OperationLogEntry): readonly LogTechnicalField[] {
  const fields: LogTechnicalField[] = [
    {
      label: '操作编号',
      value: entry.request_id === '' ? '—' : entry.request_id,
      hint: '定位单次操作的唯一编号，排查时提供',
    },
    {
      label: '记录编号',
      value: entry.target_id === null ? '—' : `#${entry.target_id}`,
      hint: '进货记录的内部编号',
    },
    {
      label: '操作账号',
      value: entry.actor === 'system' ? '系统自动' : entry.actor === '' ? '—' : entry.actor,
      hint: '执行本次操作的账号',
    },
    {
      label: '涉及内容',
      value:
        entry.target_type === 'none'
          ? '无'
          : (TARGET_TYPE_LABELS[entry.target_type] ?? '其他内容'),
      hint: '本次操作关联的数据类型',
    },
  ];
  for (const [key, value] of Object.entries(entry.detail ?? {})) {
    // requestId 与「操作编号」同源，不重复列两遍。
    if (key === 'requestId') {
      continue;
    }
    fields.push({
      label: DETAIL_FIELD_LABELS[key] ?? '补充说明',
      value: describeDetailValue(key, value),
      hint: DETAIL_FIELD_HINTS[key] ?? '系统记录的原始信息',
    });
  }
  return fields;
}
