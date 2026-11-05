/**
 * 三选二联动字段分组容器。
 *
 * 只负责分组外框、标题、说明与「覆盖后锁定」提示；
 * 具体联动算法全部在 `@stockin/domain`（`RecordForm` 调用），本组件不参与计算。
 */
import React from 'react';
import { Tag, Typography } from 'antd';

export interface FieldGroupProps {
  readonly title: string;
  readonly hint: string;
  /** 组是否因「手填覆盖自动值」而锁定（锁定后不再重算）。 */
  readonly locked: boolean;
  readonly children: React.ReactNode;
}

const FieldGroup: React.FC<FieldGroupProps> = ({ title, hint, locked, children }) => (
  <fieldset className="stockin-field-group">
    <div className="stockin-field-group-head">
      <legend className="stockin-field-group-title">{title}</legend>
      {locked ? (
        <Tag color="warning">已锁定 · 不再自动重算</Tag>
      ) : (
        <Tag color="processing">三选二联动</Tag>
      )}
    </div>
    <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 12 }}>
      {hint}
    </Typography.Paragraph>
    {children}
  </fieldset>
);

export default FieldGroup;
