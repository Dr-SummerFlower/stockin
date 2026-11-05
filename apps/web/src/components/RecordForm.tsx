/**
 * 进货记录表单（10 字段 + 两组三选二联动 + 6 个来源位）。
 *
 * 依据：设计文档 §2.4（10 字段、两组三选二）、§5.1（raw/parsed 双态、
 * 「自动值可手动覆盖，覆盖后不再重算」）、主理人 T04 口径 ③④。
 *
 * - 联动**全部**交给 `@stockin/domain`：`applyFieldEvent` 驱动状态机，
 *   提交前再用 `computeDateGroup` / `computeAmountGroup` 做权威复核；
 *   本组件不重新实现任何算术或推导。
 * - 组锁定（用户覆盖了 AUTO 槽）时，**不调用**推导函数，严格保留手填值。
 * - 6 个来源位随 `RecordDraft.sources` 持久化；进货日期无来源位。
 * - 单位下拉只在展示层用 `SHORT_UNIT_LABELS` 映射单字，提交值仍是 shared 短码，
 *   因此 Excel 导出的「12个月」闭环不被打断。
 * - 不传 `today` 给 `computeDateGroup`，不消费其派生展示字段（临期标记口径 ⑤）。
 */
import React, { useState } from 'react';
import { Alert, Button, Col, Input, Row, Select, Space, Tag, Typography } from 'antd';
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
import FieldGroup from '@/components/FieldGroup';
import {
  FIELD_SOURCE_META,
  RECORD_FIELD_LABELS,
  TOUCH_TARGET_MIN_PX,
} from '@/constants/routes';
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

/**
 * 由持久化视图恢复联动状态。
 * `locked` 不落库，编辑初始一律按 false 处理；用户覆盖 AUTO 槽时会再次锁定。
 * 这是「可恢复数据 ⊆ 状态机状态」的已知限制，见回传偏差说明。
 */
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
    unitPrice: {
      raw: state.amount.unitPrice.raw,
      parsed: state.amount.unitPrice.parsed,
    },
    quantity: {
      raw: state.amount.quantity.raw,
      parsed: state.amount.quantity.parsed,
    },
    amount: {
      raw: state.amount.amount.raw,
      parsed: state.amount.amount.parsed,
    },
  };
}

function amountSourcesOf(state: LinkageState): AmountGroupSourceMap {
  return {
    unitPrice: state.amount.unitPrice.source,
    quantity: state.amount.quantity.source,
    amount: state.amount.amount.source,
  };
}

/**
 * 组装提交载荷。
 * 非锁定组用 domain 的 `computeDateGroup` / `computeAmountGroup` 结果作为权威值；
 * 锁定组直接取当前状态，保证「手填覆盖后不再重算」。
 */
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
    return '进货日期须为合法的 YYYY-MM-DD';
  }
  if (
    state.date.productionDate.value !== null &&
    !isValidISODate(state.date.productionDate.value)
  ) {
    return '生产日期不合法，请填写 YYYY-MM-DD';
  }
  if (state.date.expiryDate.value !== null && !isValidISODate(state.date.expiryDate.value)) {
    return '到期日期不合法，请填写 YYYY-MM-DD';
  }
  const numeric: readonly (readonly [string, string, number | null])[] = [
    ['单价', state.amount.unitPrice.raw, state.amount.unitPrice.parsed],
    ['数量', state.amount.quantity.raw, state.amount.quantity.parsed],
    ['金额', state.amount.amount.raw, state.amount.amount.parsed],
  ];
  for (const [label, raw, parsed] of numeric) {
    if (raw.trim() !== '' && parsed === null) {
      return `${label} 数值格式不完整，请补全后提交`;
    }
  }
  return null;
}

/** 字段标签 + 来源三态标记（颜色 + 文字双通道）。 */
const FieldLabel: React.FC<{ readonly label: string; readonly source: FieldSource }> = ({
  label,
  source,
}) => {
  const meta = FIELD_SOURCE_META[source];
  return (
    <div style={{ marginBottom: 4 }}>
      <span style={{ fontWeight: 500 }}>{label}</span>
      <Tag className="stockin-source-tag" color={meta.color}>
        {meta.text}
      </Tag>
    </div>
  );
};

const RecordForm: React.FC<RecordFormProps> = ({
  initial = null,
  submitting = false,
  onSubmit,
  onCancel,
}) => {
  const [base, setBase] = useState<BaseFields>(() => baseFrom(initial));
  const [linkage, setLinkage] = useState<LinkageState>(() => linkageFrom(initial));
  const [shelfUnit, setShelfUnit] = useState<ShelfLifeUnit>(
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
      setFormError(errorMessage(cause, '保存失败，请稍后重试'));
    }
  };

  return (
    <form onSubmit={submit} noValidate>
      {formError !== null ? (
        <Alert
          type="error"
          showIcon
          message={formError}
          closable
          onClose={(): void => setFormError(null)}
          style={{ marginBottom: 12 }}
        />
      ) : null}

      {/* 基础信息：商品名称 / 进货日期 / 规格 / 备注 */}
      <div className="stockin-field-group">
        <div className="stockin-field-group-head">
          <legend className="stockin-field-group-title">基础信息</legend>
          <Tag color="blue">进货日期无来源位</Tag>
        </div>
        <Row gutter={[12, 12]}>
          <Col xs={24} md={8}>
            <div style={{ marginBottom: 4, fontWeight: 500 }}>
              {RECORD_FIELD_LABELS.name ?? '商品名称'}
            </div>
            <Input
              value={base.name}
              placeholder="必填，如：某品牌牛奶"
              aria-label="商品名称"
              maxLength={200}
              onChange={(event: React.ChangeEvent<HTMLInputElement>): void =>
                patchBase({ name: event.target.value })
              }
              style={{ minHeight: TOUCH_TARGET_MIN_PX }}
            />
          </Col>
          <Col xs={24} md={8}>
            <div style={{ marginBottom: 4, fontWeight: 500 }}>
              {RECORD_FIELD_LABELS.purchaseDate ?? '进货日期'}
            </div>
            <Input
              value={base.purchaseDate}
              placeholder="必填 YYYY-MM-DD"
              aria-label="进货日期"
              status={
                base.purchaseDate.trim() !== '' &&
                (!isDateString(base.purchaseDate.trim()) ||
                  !isValidISODate(base.purchaseDate.trim()))
                  ? 'error'
                  : undefined
              }
              onChange={(event: React.ChangeEvent<HTMLInputElement>): void =>
                patchBase({ purchaseDate: event.target.value })
              }
              style={{ minHeight: TOUCH_TARGET_MIN_PX }}
            />
          </Col>
          <Col xs={24} md={8}>
            <div style={{ marginBottom: 4, fontWeight: 500 }}>
              {RECORD_FIELD_LABELS.spec ?? '规格'}
            </div>
            <Input
              value={base.spec}
              placeholder="选填"
              aria-label="规格"
              maxLength={200}
              onChange={(event: React.ChangeEvent<HTMLInputElement>): void =>
                patchBase({ spec: event.target.value })
              }
              style={{ minHeight: TOUCH_TARGET_MIN_PX }}
            />
          </Col>
          <Col xs={24}>
            <div style={{ marginBottom: 4, fontWeight: 500 }}>
              {RECORD_FIELD_LABELS.remark ?? '备注'}
            </div>
            <Input.TextArea
              value={base.remark}
              placeholder="选填（备注不参与八项判重）"
              aria-label="备注"
              maxLength={1000}
              autoSize={{ minRows: 2, maxRows: 4 }}
              onChange={(event: React.ChangeEvent<HTMLTextAreaElement>): void =>
                patchBase({ remark: event.target.value })
              }
            />
          </Col>
        </Row>
      </div>

      {/* 日期组：三选二联动 */}
      <FieldGroup
        title="日期组（三选二）"
        hint="生产日期 / 保质期 / 到期日期中任意手填两项，第三项由 @stockin/domain 自动推算。自动值可被手动覆盖，覆盖后本组锁定、不再自动重算。"
        locked={linkage.date.locked}
      >
        <Row gutter={[12, 12]}>
          <Col xs={24} md={8}>
            <FieldLabel
              label={RECORD_FIELD_LABELS.productionDate ?? '生产日期'}
              source={linkage.date.productionDate.source}
            />
            <Input
              value={linkage.date.productionDate.value ?? ''}
              placeholder="YYYY-MM-DD"
              aria-label="生产日期"
              onChange={(event: React.ChangeEvent<HTMLInputElement>): void =>
                dispatch({
                  type: 'userInput',
                  slot: 'productionDate',
                  raw: event.target.value,
                })
              }
              style={{ minHeight: TOUCH_TARGET_MIN_PX }}
            />
          </Col>
          <Col xs={24} md={8}>
            <FieldLabel
              label={RECORD_FIELD_LABELS.shelfLife ?? '保质期'}
              source={linkage.date.shelfLife.source}
            />
            <div style={{ display: 'flex', gap: 8 }}>
              <Input
                value={shelfValueText}
                inputMode="numeric"
                placeholder="数值，如 12"
                aria-label="保质期数值"
                onChange={(event: React.ChangeEvent<HTMLInputElement>): void =>
                  dispatch({
                    type: 'userInput',
                    slot: 'shelfLife',
                    raw: event.target.value,
                    unit: shelfUnit,
                  })
                }
                style={{ flex: 1, minHeight: TOUCH_TARGET_MIN_PX }}
              />
              <Select<ShelfLifeUnit>
                value={shelfUnit}
                aria-label="保质期单位"
                options={UNIT_OPTIONS}
                onChange={(unit: ShelfLifeUnit): void => {
                  setShelfUnit(unit);
                  dispatch({
                    type: 'userInput',
                    slot: 'shelfLife',
                    raw: shelfValueText,
                    unit,
                  });
                }}
                style={{ width: 96, minHeight: TOUCH_TARGET_MIN_PX }}
              />
            </div>
          </Col>
          <Col xs={24} md={8}>
            <FieldLabel
              label={RECORD_FIELD_LABELS.expiryDate ?? '到期日期'}
              source={linkage.date.expiryDate.source}
            />
            <Input
              value={linkage.date.expiryDate.value ?? ''}
              placeholder="YYYY-MM-DD"
              aria-label="到期日期"
              onChange={(event: React.ChangeEvent<HTMLInputElement>): void =>
                dispatch({
                  type: 'userInput',
                  slot: 'expiryDate',
                  raw: event.target.value,
                })
              }
              style={{ minHeight: TOUCH_TARGET_MIN_PX }}
            />
          </Col>
        </Row>
      </FieldGroup>

      {/* 金额组：三选二联动 */}
      <FieldGroup
        title="金额组（三选二）"
        hint="单价 / 数量 / 金额中任意手填两项，第三项按整数定点运算自动推算（除零不执行）。raw/parsed 双态避免 0. 等中间态被误判。"
        locked={linkage.amount.locked}
      >
        <Row gutter={[12, 12]}>
          <Col xs={24} md={8}>
            <FieldLabel
              label={RECORD_FIELD_LABELS.unitPrice ?? '单价'}
              source={linkage.amount.unitPrice.source}
            />
            <NumericInput
              raw={linkage.amount.unitPrice.raw}
              scale={SCALE.UNIT_PRICE}
              ariaLabel="单价"
              placeholder="0.0000"
              onRawChange={(raw: string, parsed: number | null): void =>
                dispatch({ type: 'userInput', slot: 'unitPrice', raw, parsed })
              }
            />
          </Col>
          <Col xs={24} md={8}>
            <FieldLabel
              label={RECORD_FIELD_LABELS.quantity ?? '数量'}
              source={linkage.amount.quantity.source}
            />
            <NumericInput
              raw={linkage.amount.quantity.raw}
              scale={SCALE.QUANTITY}
              ariaLabel="数量"
              placeholder="0.000"
              onRawChange={(raw: string, parsed: number | null): void =>
                dispatch({ type: 'userInput', slot: 'quantity', raw, parsed })
              }
            />
          </Col>
          <Col xs={24} md={8}>
            <FieldLabel
              label={RECORD_FIELD_LABELS.amountCents ?? '金额'}
              source={linkage.amount.amount.source}
            />
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
          </Col>
        </Row>
      </FieldGroup>

      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        提交时随载荷持久化 6 个来源位（EMPTY / AUTO / MANUAL）；服务端只校验不重算。
        单位下拉为展示层单字映射，提交与 Excel 导出仍使用 shared 的「12个月」标签真源。
      </Typography.Paragraph>

      <Space wrap style={{ marginTop: 8 }}>
        <Button
          type="primary"
          htmlType="submit"
          loading={submitting}
          style={{ minHeight: TOUCH_TARGET_MIN_PX, minWidth: 96 }}
        >
          {initial === null ? '新增记录' : '保存修改'}
        </Button>
        <Button
          onClick={onCancel}
          disabled={submitting}
          style={{ minHeight: TOUCH_TARGET_MIN_PX }}
        >
          取消
        </Button>
      </Space>
    </form>
  );
};

export default RecordForm;
