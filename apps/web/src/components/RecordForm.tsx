/**
 * 进货记录表单（10 字段 + 两组三选二联动 + 6 个来源位）。
 *
 * 依据：设计文档 §2.4（10 字段、两组三选二）、design/stockin-ui-design-system.md §5.3。
 * 三步线性：01 基础信息 → 02 日期组 → 03 金额组；联动规则只在「三选二」badge
 * 的说明面板里交代一次，不再在字段下方逐条重复。
 * 来源三态用「中文标签 + 语义色 + 输入底色」三通道，颜色不单独承载状态。
 *
 * 业务语义一律不变：
 * - 联动**全部**交给 `@stockin/domain`：`applyFieldEvent` 驱动状态机，
 *   提交前再用 `computeDateGroup` / `computeAmountGroup` 做权威复核；
 *   本组件不重新实现任何算术或推导，原型中的演示 JS 不落地。
 * - 组锁定（用户覆盖了 AUTO 槽）时，**不调用**推导函数，严格保留手填值。
 * - 6 个来源位随 `RecordDraft.sources` 持久化；进货日期无来源位。
 * - 不传 `today` 给 `computeDateGroup`，不消费其派生展示字段。
 *
 * 交互：文本、数值、日期、单位**一律用 antd 控件**（Input / Input.TextArea / DatePicker /
 * Select），与列表页筛选、弹窗保持同一套外观与交互；日期值仍是 YYYY-MM-DD 字符串，
 * 后端契约不变，三天字段的联动全部由 `@stockin/domain` 负责。
 */
import React, { useState } from 'react';
import { Alert, Button, Input, Select } from 'antd';
import {
  SCALE,
  SHELF_LIFE_UNITS,
  type FieldSource,
  type RecordDraft,
  type RecordView,
  type ShelfLifeUnit,
} from '@stockin/shared';
import {
  applyFieldEvent,
  computeAmountGroup,
  computeDateGroup,
  createInitialLinkageState,
  isValidISODate,
  type AmountGroupSourceMap,
  type AmountGroupValues,
  type DateGroupSourceMap,
  type DateGroupValues,
  type FieldEvent,
  type LinkageState,
} from '@stockin/domain';
import NumericInput from '@/components/NumericInput';
import DateInput from '@/components/DateInput';
import FieldGroup from '@/components/FieldGroup';
import Icon from '@/components/Icon';
import SuggestionInput from '@/components/SuggestionInput';
import { RECORD_FIELD_LABELS, TOUCH_TARGET_MIN_PX } from '@/constants/routes';
import {
  formatMoneyInput,
  formatQuantity,
  formatUnitPrice,
  isDateString,
  SHORT_UNIT_LABELS,
} from '@/utils/format';
import { createIdempotencyKey } from '@/utils/idempotency-key';
import { errorMessage } from '@/services/request';

export interface RecordFormProps {
  /** 编辑时传入记录视图；新建传 null。 */
  readonly initial?: RecordView | null;
  readonly submitting?: boolean;
  readonly onSubmit: (draft: RecordDraft) => void | Promise<void>;
  readonly onCancel: () => void;
}

interface BaseFields {
  name: string;
  purchaseDate: string;
  spec: string;
  remark: string;
}

const UNIT_OPTIONS: { value: ShelfLifeUnit; label: string }[] = SHELF_LIFE_UNITS.map(
  (unit) => ({ value: unit, label: SHORT_UNIT_LABELS[unit] }),
);

function baseFrom(view: RecordView | null): BaseFields {
  return {
    name: view?.name ?? '',
    purchaseDate: view?.purchaseDate ?? '',
    spec: view?.spec ?? '',
    remark: view?.remark ?? '',
  };
}

/** 由持久化视图恢复联动状态；`locked` 不落库，编辑初始一律按 false 处理。 */
function linkageFrom(view: RecordView | null): LinkageState {
  if (view === null) {
    return createInitialLinkageState();
  }
  const shelfValue =
    view.shelfLifeValue !== null && view.shelfLifeUnit !== null
      ? { value: view.shelfLifeValue, unit: view.shelfLifeUnit }
      : null;
  return {
    date: {
      productionDate: {
        value: view.productionDate,
        source: view.sources.productionDateSrc,
      },
      shelfLife: { value: shelfValue, source: view.sources.shelfLifeSrc },
      expiryDate: { value: view.expiryDate, source: view.sources.expiryDateSrc },
      locked: false,
    },
    amount: {
      unitPrice: {
        raw: formatUnitPrice(view.unitPrice),
        parsed: view.unitPrice,
        source: view.sources.unitPriceSrc,
      },
      quantity: {
        raw: formatQuantity(view.quantity),
        parsed: view.quantity,
        source: view.sources.quantitySrc,
      },
      amount: {
        raw: formatMoneyInput(view.amountCents),
        parsed: view.amountCents,
        source: view.sources.amountSrc,
      },
      locked: false,
    },
  };
}

/* ---- LinkageState ↔ domain 计算入参的字段映射（仅映射，不含任何算法） ---- */

function dateValuesOf(state: LinkageState): DateGroupValues {
  return {
    productionDate: state.date.productionDate.value,
    shelfLifeValue: state.date.shelfLife.value?.value ?? null,
    shelfLifeUnit: state.date.shelfLife.value?.unit ?? null,
    expiryDate: state.date.expiryDate.value,
  };
}

function dateSourcesOf(state: LinkageState): DateGroupSourceMap {
  return {
    productionDate: state.date.productionDate.source,
    shelfLife: state.date.shelfLife.source,
    expiryDate: state.date.expiryDate.source,
  };
}

function amountValuesOf(state: LinkageState): AmountGroupValues {
  return {
    unitPrice: { raw: state.amount.unitPrice.raw, parsed: state.amount.unitPrice.parsed },
    quantity: { raw: state.amount.quantity.raw, parsed: state.amount.quantity.parsed },
    amount: { raw: state.amount.amount.raw, parsed: state.amount.amount.parsed },
  };
}

function amountSourcesOf(state: LinkageState): AmountGroupSourceMap {
  return {
    unitPrice: state.amount.unitPrice.source,
    quantity: state.amount.quantity.source,
    amount: state.amount.amount.source,
  };
}

/** 组装提交载荷；锁定组直接取当前状态，保证「手填覆盖后不再重算」。 */
export function buildRecordDraft(
  base: BaseFields,
  state: LinkageState,
  view: RecordView | null,
): RecordDraft {
  const dateResult = state.date.locked
    ? { values: dateValuesOf(state), sources: dateSourcesOf(state) }
    : computeDateGroup(dateValuesOf(state), dateSourcesOf(state));
  const amountResult = state.amount.locked
    ? { values: amountValuesOf(state), sources: amountSourcesOf(state) }
    : computeAmountGroup(amountValuesOf(state), amountSourcesOf(state));

  const draft: RecordDraft = {
    name: base.name.trim(),
    purchaseDate: base.purchaseDate.trim(),
    productionDate: dateResult.values.productionDate,
    shelfLifeValue: dateResult.values.shelfLifeValue,
    shelfLifeUnit: dateResult.values.shelfLifeUnit,
    expiryDate: dateResult.values.expiryDate,
    spec: base.spec.trim() === '' ? null : base.spec.trim(),
    unitPrice: amountResult.values.unitPrice.parsed ?? 0,
    quantity: amountResult.values.quantity.parsed ?? 0,
    amountCents: amountResult.values.amount.parsed ?? 0,
    remark: base.remark.trim() === '' ? null : base.remark.trim(),
    sources: {
      productionDateSrc: dateResult.sources.productionDate,
      shelfLifeSrc: dateResult.sources.shelfLife,
      expiryDateSrc: dateResult.sources.expiryDate,
      unitPriceSrc: amountResult.sources.unitPrice,
      quantitySrc: amountResult.sources.quantity,
      amountSrc: amountResult.sources.amount,
    },
    idempotencyKey: createIdempotencyKey(),
  };
  if (view !== null) {
    draft.version = view.version;
  }
  return draft;
}

/** 提交前本地校验；返回首个错误文案，null 表示通过。 */
export function validateRecordForm(base: BaseFields, state: LinkageState): string | null {
  if (base.name.trim() === '') {
    return '商品名称不能为空';
  }
  const purchaseDate: string = base.purchaseDate.trim();
  if (!isDateString(purchaseDate) || !isValidISODate(purchaseDate)) {
    return '进货日期格式不正确';
  }
  if (
    state.date.productionDate.value !== null &&
    !isValidISODate(state.date.productionDate.value)
  ) {
    return '生产日期格式不正确';
  }
  if (state.date.expiryDate.value !== null && !isValidISODate(state.date.expiryDate.value)) {
    return '到期日期格式不正确';
  }
  const numeric: readonly (readonly [string, string, number | null])[] = [
    ['单价', state.amount.unitPrice.raw, state.amount.unitPrice.parsed],
    ['数量', state.amount.quantity.raw, state.amount.quantity.parsed],
    ['金额', state.amount.amount.raw, state.amount.amount.parsed],
  ];
  for (const [label, raw, parsed] of numeric) {
    if (raw.trim() !== '' && parsed === null) {
      return `${label}格式不正确`;
    }
  }
  return null;
}

/** 来源三态：中文标签 + 语义色 + 输入底色三通道，颜色不单独承载状态。 */
const SOURCE_TAG: Readonly<
  Record<string, { readonly cls: string; readonly text: string }>
> = {
  EMPTY: { cls: 'stockin-tag--empty', text: '未填写' },
  AUTO: { cls: 'stockin-tag--auto', text: '自动推算' },
  MANUAL: { cls: 'stockin-tag--manual', text: '手填' },
};

const SourceTag: React.FC<{ readonly source: FieldSource }> = ({ source }) => {
  const meta = SOURCE_TAG[source] ?? { cls: 'stockin-tag--none', text: '未标注' };
  return (
    <span className={`stockin-tag ${meta.cls}`}>
      <i aria-hidden="true" />
      {meta.text}
    </span>
  );
};

/** 字段名 + 来源标签 + 输入控件；格式与约束交给控件本身（占位符 / 校验）。 */
const BadgedField: React.FC<{
  readonly label: string;
  readonly source: FieldSource;
  readonly children: React.ReactNode;
}> = ({ label, source, children }) => (
  <div className="stockin-field-wrap">
    <div className="stockin-field-label">
      <span>{label}</span>
      <SourceTag source={source} />
    </div>
    <div className={source === 'AUTO' ? 'stockin-field-auto' : undefined}>{children}</div>
  </div>
);

const RecordForm: React.FC<RecordFormProps> = ({
  initial = null,
  submitting = false,
  onSubmit,
  onCancel,
}) => {
  const [base, setBase] = useState<BaseFields>(() => baseFrom(initial));
  const [linkage, setLinkage] = useState<LinkageState>(() => linkageFrom(initial));
  /**
   * 单位兜底值：仅在保质期尚未成形（数值或单位为空）时使用。
   * 一旦联动状态里有单位（包括「生产日期 + 到期日期」自动推算出的单位），
   * 一律以联动状态为准，避免出现「数值是 29 天、下拉却显示月」的错位。
   */
  const [shelfUnitFallback, setShelfUnitFallback] = useState<ShelfLifeUnit>(
    () => initial?.shelfLifeUnit ?? 'month',
  );
  const [formError, setFormError] = useState<string | null>(null);

  const dispatch = (event: FieldEvent): void => {
    setLinkage((prev: LinkageState): LinkageState => applyFieldEvent(prev, event));
  };

  const patchBase = (patch: Partial<BaseFields>): void => {
    setBase((prev: BaseFields): BaseFields => ({ ...prev, ...patch }));
  };

  const shelfValueText: string =
    linkage.date.shelfLife.value !== null
      ? String(linkage.date.shelfLife.value.value)
      : '';

  /** 联动状态里的单位优先；未成形时才回落到本地选择（默认月）。 */
  const shelfUnit: ShelfLifeUnit =
    linkage.date.shelfLife.value?.unit ?? shelfUnitFallback;

  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const invalid: string | null = validateRecordForm(base, linkage);
    if (invalid !== null) {
      setFormError(invalid);
      return;
    }
    setFormError(null);
    try {
      await onSubmit(buildRecordDraft(base, linkage, initial));
    } catch (cause) {
      setFormError(errorMessage(cause, '保存失败'));
    }
  };

  return (
    <form className="stockin-form-layout" onSubmit={submit} noValidate>
      <div className="stockin-form-main">
        {formError !== null ? (
          <Alert
            type="error"
            showIcon
            message={formError}
            closable
            onClose={(): void => setFormError(null)}
          />
        ) : null}

        <FieldGroup title="基础信息" tourId="record-base">
          <div className="stockin-form-grid">
            <div className="stockin-field-wrap">
              <div className="stockin-field-label">
                <span>
                  {RECORD_FIELD_LABELS.name ?? '商品名称'}
                  <span aria-hidden="true" style={{ color: 'var(--stockin-color-expired)' }}>
                    {' '}*
                  </span>
                </span>
              </div>
              <SuggestionInput
                field="name"
                value={base.name}
                ariaLabel="商品名称"
                placeholder="请输入商品名称"
                maxLength={200}
                onChange={(value: string): void => patchBase({ name: value })}
                onPick={(item): void => {
                  // 只补空/覆盖规格与单价：用户从历史名称里选，本身就是明确意图。
                  if (item.spec !== null && item.spec !== '') {
                    patchBase({ spec: item.spec });
                  }
                  if (item.unitPrice !== null && item.unitPrice > 0) {
                    dispatch({
                      type: 'userInput',
                      slot: 'unitPrice',
                      raw: formatUnitPrice(item.unitPrice),
                      parsed: item.unitPrice,
                    });
                  }
                }}
              />
            </div>

            <div className="stockin-field-wrap">
              <div className="stockin-field-label">
                <span>
                  {RECORD_FIELD_LABELS.purchaseDate ?? '进货日期'}
                  <span aria-hidden="true" style={{ color: 'var(--stockin-color-expired)' }}>
                    {' '}*
                  </span>
                </span>
              </div>
              <DateInput
                value={base.purchaseDate}
                ariaLabel="进货日期"
                required
                onChange={(next: string): void => patchBase({ purchaseDate: next })}
              />
            </div>

            <div className="stockin-field-wrap">
              <div className="stockin-field-label">
                <span>{RECORD_FIELD_LABELS.spec ?? '规格'}</span>
              </div>
              <SuggestionInput
                field="spec"
                value={base.spec}
                ariaLabel="规格"
                placeholder="请输入规格"
                maxLength={200}
                onChange={(value: string): void => patchBase({ spec: value })}
              />
            </div>

            <div className="stockin-field-wrap">
              <div className="stockin-field-label">
                <span>{RECORD_FIELD_LABELS.remark ?? '备注'}</span>
              </div>
              <Input.TextArea
                value={base.remark}
                aria-label="备注"
                placeholder="请输入额外信息"
                maxLength={1000}
                autoSize={{ minRows: 2, maxRows: 4 }}
                onChange={(event: React.ChangeEvent<HTMLTextAreaElement>): void =>
                  patchBase({ remark: event.target.value })
                }
              />
            </div>
          </div>
        </FieldGroup>

        <FieldGroup title="日期信息" badge="三选二" locked={linkage.date.locked} tourId="record-date">
          <div className="stockin-form-grid is-three">
            <BadgedField
              label={RECORD_FIELD_LABELS.productionDate ?? '生产日期'}
              source={linkage.date.productionDate.source}
            >
              <DateInput
                value={linkage.date.productionDate.value ?? ''}
                ariaLabel="生产日期"
                onChange={(next: string): void =>
                  dispatch({ type: 'userInput', slot: 'productionDate', raw: next })
                }
              />
            </BadgedField>

            <BadgedField
              label={RECORD_FIELD_LABELS.shelfLife ?? '保质期'}
              source={linkage.date.shelfLife.source}
            >
              <div className="stockin-input-group">
                <Input
                  value={shelfValueText}
                  inputMode="numeric"
                  placeholder="请输入数值"
                  aria-label="保质期数值"
                  className="stockin-shelf-value"
                  onChange={(event: React.ChangeEvent<HTMLInputElement>): void =>
                    dispatch({
                      type: 'userInput',
                      slot: 'shelfLife',
                      raw: event.target.value,
                      unit: shelfUnit,
                    })
                  }
                />
                <Select<ShelfLifeUnit>
                  value={shelfUnit}
                  aria-label="保质期单位"
                  options={UNIT_OPTIONS}
                  popupMatchSelectWidth={false}
                  getPopupContainer={(): HTMLElement => document.body}
                  onChange={(unit: ShelfLifeUnit): void => {
                    setShelfUnitFallback(unit);
                    dispatch({
                      type: 'userInput',
                      slot: 'shelfLife',
                      raw: shelfValueText,
                      unit,
                    });
                  }}
                  className="stockin-shelf-unit"
                />
              </div>
            </BadgedField>

            <BadgedField
              label={RECORD_FIELD_LABELS.expiryDate ?? '到期日期'}
              source={linkage.date.expiryDate.source}
            >
              <DateInput
                value={linkage.date.expiryDate.value ?? ''}
                ariaLabel="到期日期"
                onChange={(next: string): void =>
                  dispatch({ type: 'userInput', slot: 'expiryDate', raw: next })
                }
              />
            </BadgedField>
          </div>
        </FieldGroup>

        <FieldGroup title="金额信息" badge="三选二" locked={linkage.amount.locked} tourId="record-amount">
          <div className="stockin-form-grid is-three">
            <BadgedField
              label={RECORD_FIELD_LABELS.unitPrice ?? '单价'}
              source={linkage.amount.unitPrice.source}
            >
              <NumericInput
                raw={linkage.amount.unitPrice.raw}
                scale={SCALE.UNIT_PRICE}
                ariaLabel="单价"
                placeholder="0.0000"
                onRawChange={(raw: string, parsed: number | null): void =>
                  dispatch({ type: 'userInput', slot: 'unitPrice', raw, parsed })
                }
              />
            </BadgedField>

            <BadgedField
              label={RECORD_FIELD_LABELS.quantity ?? '数量'}
              source={linkage.amount.quantity.source}
            >
              <NumericInput
                raw={linkage.amount.quantity.raw}
                scale={SCALE.QUANTITY}
                ariaLabel="数量"
                placeholder="0.000"
                onRawChange={(raw: string, parsed: number | null): void =>
                  dispatch({ type: 'userInput', slot: 'quantity', raw, parsed })
                }
              />
            </BadgedField>

            <BadgedField
              label={RECORD_FIELD_LABELS.amountCents ?? '金额'}
              source={linkage.amount.amount.source}
            >
              <NumericInput
                raw={linkage.amount.amount.raw}
                scale={SCALE.AMOUNT_CENTS}
                ariaLabel="金额"
                placeholder="0.00"
                addonBefore="¥"
                onRawChange={(raw: string, parsed: number | null): void =>
                  dispatch({ type: 'userInput', slot: 'amount', raw, parsed })
                }
              />
            </BadgedField>
          </div>
        </FieldGroup>

        <div
          className="stockin-submit-bar"
          data-tour-id="record-submit"
          style={{ justifyContent: 'flex-end' }}
        >
          <div className="stockin-btn-row">
            <Button
              onClick={onCancel}
              disabled={submitting}
              style={{ minHeight: TOUCH_TARGET_MIN_PX }}
            >
              取消
            </Button>
            <Button
              type="primary"
              htmlType="submit"
              loading={submitting}
              icon={<Icon name="check" size="sm" />}
              style={{ minHeight: TOUCH_TARGET_MIN_PX, minWidth: 96 }}
            >
              {initial === null ? '保存记录' : '保存修改'}
            </Button>
          </div>
        </div>
      </div>
    </form>
  );
};

export default RecordForm;
