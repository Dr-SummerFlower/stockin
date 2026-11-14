/**
 * 技术信息区（备份元数据 / 操作日志排查字段共用）。
 *
 * 每个字段独立成块：中文标签在上、完整值在中、用途说明在下。
 * 两列网格在窄屏自动降为单列；长值自然换行，可直接拖拽或长按选取，
 * 不再截断、不设复制按钮（冗余操作）。排查用的技术信息一个字段不删。
 */
import React from 'react';

export interface TechnicalField {
  readonly label: string;
  /** 完整展示值。 */
  readonly value: React.ReactNode;
  /** 一句用途说明。 */
  readonly hint: string;
  /** 值用等宽字体（编号 / 校验码 / 时间戳）。 */
  readonly mono?: boolean;
}

export interface TechnicalInfoProps {
  readonly fields: readonly TechnicalField[];
}

const TechnicalInfo: React.FC<TechnicalInfoProps> = ({ fields }) => (
  <div className="stockin-tech-grid">
    {fields.map((field: TechnicalField, index: number) => (
      <div className="stockin-tech-item" key={`${field.label}-${index}`}>
        <div className="stockin-tech-head">
          <span className="stockin-tech-label">{field.label}</span>
        </div>
        <div
          className={`stockin-tech-value${field.mono === true ? ' stockin-mono' : ''}`}
        >
          {field.value}
        </div>
        <div className="stockin-tech-hint">{field.hint}</div>
      </div>
    ))}
  </div>
);

export default TechnicalInfo;
