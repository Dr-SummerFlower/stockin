/**
 * 路由常量、导航项与展示层枚举文案。
 *
 * 依据：`.umirc.ts` 的配置式 routes；设计文档 v1.1 §2.4 展示格式口径。
 * 端点路径一律以 T03b 实际注册的 `/api/*` 为准，不在前端自创业务路径。
 */

/** 与 `.umirc.ts` 中 `routes` 一一对应的页面路径。 */
export const ROUTES = {
  login: '/login',
  setup: '/setup',
  dashboard: '/',
  records: '/records',
  recordNew: '/records/new',
  recordEdit: (id: number | string): string => `/records/${id}/edit`,
  settings: '/settings',
  trash: '/trash',
  logs: '/logs',
  notFound: '/404',
} as const;

export interface NavItem {
  readonly key: string;
  readonly path: string;
  readonly label: string;
  /** 单字图标名（AntD `@ant-design/icons` 组件名），由 layout 映射。 */
  readonly icon: 'dashboard' | 'list' | 'setting' | 'delete' | 'file';
}

/** 侧栏导航项（顺序即展示顺序）。 */
export const NAV_ITEMS: readonly NavItem[] = [
  { key: 'dashboard', path: ROUTES.dashboard, label: '统计大屏', icon: 'dashboard' },
  { key: 'records', path: ROUTES.records, label: '进货记录', icon: 'list' },
  { key: 'trash', path: ROUTES.trash, label: '回收站', icon: 'delete' },
  { key: 'logs', path: ROUTES.logs, label: '操作日志', icon: 'file' },
  { key: 'settings', path: ROUTES.settings, label: '设置', icon: 'setting' },
];

/** 临时/回收站的操作日志 action 中文文案（读日志页只读展示）。 */
export const ACTION_LABELS: Readonly<Record<string, string>> = {
  LOGIN: '登录',
  LOGIN_FAILED: '登录失败',
  LOGOUT: '退出登录',
  SETUP_COMPLETE: '完成初始化',
  RECORD_CREATE: '新增记录',
  RECORD_UPDATE: '编辑记录',
  RECORD_DELETE: '删除记录',
  RECORD_BATCH_DELETE: '批量删除记录',
  RECORD_RESTORE: '恢复记录',
  RECORD_PURGE: '彻底删除记录',
  EXCEL_TEMPLATE: '下载模板',
  EXCEL_IMPORT: '导入 Excel',
  EXCEL_EXPORT: '导出 Excel',
  SETTINGS_UPDATE: '修改设置',
  BACKUP_CREATE: '创建备份',
  BACKUP_RESTORE: '恢复备份',
  CREDENTIALS_RESET: '重置凭据',
};

/** target_type 中文文案。 */
export const TARGET_TYPE_LABELS: Readonly<Record<string, string>> = {
  record: '进货记录',
  credential: '账户凭据',
  settings: '系统设置',
  session: '会话',
  backup: '备份',
  none: '—',
};

/** 临期/过期/正常 的双通道（颜色 + 文字）展示元信息。 */
export interface StatusMeta {
  readonly label: string;
  readonly color: 'warning' | 'error' | 'default' | 'success';
  readonly text: string;
}

/** 与 `/api/dashboard` 返回的 status 对应的展示文案；颜色 + 文字双通道。 */
export const EXPIRY_STATUS_META: Readonly<Record<'near' | 'expired' | 'none', StatusMeta>> = {
  near: { label: '临期', color: 'warning', text: '临期' },
  expired: { label: '已过期', color: 'error', text: '已过期' },
  none: { label: '正常', color: 'default', text: '正常' },
};

/** 字段来源三态的展示文案（供表单联动状态提示）。 */
export const FIELD_SOURCE_META: Readonly<Record<'EMPTY' | 'AUTO' | 'MANUAL', StatusMeta>> = {
  EMPTY: { label: '空', color: 'default', text: '未填写' },
  AUTO: { label: '自动', color: 'success', text: '自动推算' },
  MANUAL: { label: '手填', color: 'default', text: '手动填写' },
};

/** 6 个联动槽位的中文标签与分组。 */
export const LINKAGE_SLOT_LABELS: Readonly<Record<string, string>> = {
  productionDate: '生产日期',
  shelfLife: '保质期',
  expiryDate: '到期日期',
  unitPrice: '单价',
  quantity: '数量',
  amount: '金额',
};

/** 10 个业务字段的中文标签（与 EXCEL_HEADERS 顺序一致）。 */
export const RECORD_FIELD_LABELS: Readonly<Record<string, string>> = {
  name: '商品名称',
  purchaseDate: '进货日期',
  productionDate: '生产日期',
  shelfLife: '保质期',
  expiryDate: '到期日期',
  spec: '规格',
  unitPrice: '单价',
  quantity: '数量',
  amountCents: '金额',
  remark: '备注',
};

/** 触控目标最小尺寸（px），响应式三档共用。 */
export const TOUCH_TARGET_MIN_PX = 44;
