/**
 * 统一的空状态：图标 + 一句结论。
 *
 * 桌面表格（antd Table 的 emptyText）、手机卡片列表、回收站共用同一实现与同一
 * 文案口径，避免两套空态（antd Empty 一行字 / 自绘块）在不同档位表现不一致。
 * 空态只陈述结论，不写「新增第一笔…」这类显而易见的操作指引。
 */
import React from 'react';
import Icon from '@/components/Icon';

type EmptyIcon = 'list' | 'trash' | 'log' | 'alert';

export interface EmptyStateProps {
  readonly icon?: EmptyIcon;
  readonly title: string;
}

const EmptyState: React.FC<EmptyStateProps> = ({ icon = 'list', title }) => (
  <div className="stockin-empty">
    <div className="stockin-empty-icon">
      <Icon name={icon} />
    </div>
    <b>{title}</b>
  </div>
);

export default EmptyState;
