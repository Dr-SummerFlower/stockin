/**
 * 表单分组外框：区块标题 + 可选标记 + 分隔线 + 内容区。
 *
 * 采用「单行标题 + 细分隔线」的紧凑区块头，避免每段都用「大标题 + 副标题」的
 * 三段式套板。
 * 只负责结构与「已锁定 · 不重算」反馈；联动算法全部在 `@stockin/domain`，
 * 本组件不参与任何计算，也不读写来源位。
 * 状态用「颜色 + 文字」双通道；未知锁定态回落中性文案。
 *
 * 「三选二」badge 承载本表单唯一的非线性规则（手动改过就不再重算），
 * 因此做成可点开的面板而不是纯装饰：用 Popover 而非 Tooltip —— Tooltip 靠
 * hover/focus 触发，触屏 tap 不稳定，手机端这条规则会彻底不可发现。
 */
import React, { useId, useState } from 'react';
import { Popover } from 'antd';

export interface FieldGroupProps {
  readonly title: string;
  /** 标题右侧的简短标记，如「三选二」；留空则不显示。 */
  readonly badge?: string;
  /** 联动组是否因「手填覆盖自动值」而锁定；不传表示非联动组。 */
  readonly locked?: boolean;
  /** 可选：供首次漫游定位的锚点标识。 */
  readonly tourId?: string;
  readonly children: React.ReactNode;
}

/** 三选二的填写规则；唯一一份文案，两处 badge 共用。 */
const LINKAGE_RULE = '填两项自动补全第三项，手动修改后不再重算。';

const BadgeHint: React.FC<{ readonly text: string }> = ({ text }) => {
  const contentId: string = useId();
  const [open, setOpen] = useState<boolean>(false);
  return (
    <Popover
      trigger={['hover', 'click']}
      placement="bottomLeft"
      arrow={{ pointAtCenter: true }}
      mouseEnterDelay={0.15}
      open={open}
      onOpenChange={setOpen}
      overlayClassName="stockin-popover"
      content={
        <div id={contentId} className="stockin-popover-panel">
          {LINKAGE_RULE}
        </div>
      }
    >
      <button
        type="button"
        className="stockin-form-section-badge"
        aria-label="三选二填写规则"
        aria-expanded={open}
        aria-describedby={open ? contentId : undefined}
      >
        {text}
      </button>
    </Popover>
  );
};

const FieldGroup: React.FC<FieldGroupProps> = ({ title, badge, locked, tourId, children }) => (
  <section className="stockin-form-section" data-tour-id={tourId}>
    <div className="stockin-form-section-head">
      <div className="stockin-form-section-heading">
        <h3>{title}</h3>
        {badge !== undefined ? <BadgeHint text={badge} /> : null}
      </div>
      {locked === true ? (
        <span className="stockin-tag stockin-tag--manual">
          <i aria-hidden="true" />
          已锁定，不自动重算
        </span>
      ) : null}
    </div>
    <div className="stockin-form-section-body">{children}</div>
  </section>
);

export default FieldGroup;
