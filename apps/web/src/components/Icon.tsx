/**
 * 图标组件：基于 lucide-react（内联 SVG 组件，CSP 安全、零外部请求）。
 *
 * 沿用 design 系统的 1.7px 描边、18px 尺寸与 `currentColor` 主题色，规则在
 * global.css 的 `.stockin-icon` / `.stockin-icon--sm` 中定义，因此替换后尺寸、
 * 暗色主题、响应式完全不变；本组件只负责把 `IconName` 映射到 Lucide 图标。
 * 图标恒为装饰性，按钮/链接需自带 aria-label 或可见文字。
 */
import React, { type CSSProperties } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  Boxes,
  Calendar,
  CalendarX,
  Check,
  ChevronRight,
  Clock,
  Download,
  FileSpreadsheet,
  FileText,
  Info,
  Layers,
  LayoutGrid,
  List,
  LogOut,
  type LucideIcon,
  Monitor,
  Moon,
  Palette,
  Pencil,
  Plus,
  ReceiptText,
  RefreshCw,
  Search,
  Settings,
  Sun,
  Trash2,
  Upload,
  Wallet,
  X,
} from 'lucide-react';

export type IconName =
  | 'grid'
  | 'list'
  | 'trash'
  | 'log'
  | 'setting'
  | 'plus'
  | 'download'
  | 'upload'
  | 'template'
  | 'refresh'
  | 'chevron'
  | 'check'
  | 'alert'
  | 'clock'
  | 'logout'
  | 'edit'
  | 'info'
  | 'palette'
  | 'close'
  | 'search'
  | 'arrowLeft'
  | 'sun'
  | 'moon'
  | 'monitor'
  | 'wallet'
  | 'receipt'
  | 'boxes'
  | 'layers'
  | 'calendar'
  | 'calendarX';

const SHAPES: Readonly<Record<IconName, LucideIcon>> = {
  grid: LayoutGrid,
  list: List,
  trash: Trash2,
  log: FileText,
  setting: Settings,
  plus: Plus,
  download: Download,
  upload: Upload,
  template: FileSpreadsheet,
  refresh: RefreshCw,
  chevron: ChevronRight,
  check: Check,
  alert: AlertTriangle,
  clock: Clock,
  logout: LogOut,
  edit: Pencil,
  info: Info,
  palette: Palette,
  close: X,
  search: Search,
  arrowLeft: ArrowLeft,
  sun: Sun,
  moon: Moon,
  monitor: Monitor,
  wallet: Wallet,
  receipt: ReceiptText,
  boxes: Boxes,
  layers: Layers,
  calendar: Calendar,
  calendarX: CalendarX,
};

export interface IconProps {
  readonly name: IconName;
  readonly size?: 'sm' | 'md';
  readonly className?: string;
  readonly style?: CSSProperties;
}

const Icon: React.FC<IconProps> = ({ name, size = 'md', className, style }) => {
  const Lucide = SHAPES[name];
  const classes = ['stockin-icon', size === 'sm' ? 'stockin-icon--sm' : '', className ?? '']
    .filter(Boolean)
    .join(' ');
  return <Lucide className={classes} style={style} aria-hidden="true" focusable={false} />;
};

export default Icon;
