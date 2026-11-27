/**
 * 进货单录入表单：抬头（供货商 / 单号 / 日期 / 备注）+ N 行明细，一次保存。
 *
 * 设计依据：`.tmp/UI/进货单v2-设计稿.html` 的「记一笔」（手机）与「新增进货单」（PC）。
 *
 * 业务口径与单条记录完全一致 —— 本组件不实现任何联动算法：
 * - 每行的日期组 / 金额组状态机仍由 `@stockin/domain` 的 `applyFieldEvent` 驱动；
 * - 提交前用 `buildRecordDraft`（RecordForm 导出）产出 `RecordDraft`，
 *   与单条新增走同一条装配路径，服务端只校验不重算；
 * - 整单只有一个供货商与一个进货日期，明细不再各自持有日期（单头日期覆盖）。
 *
 * 两条增强：
 * 1. 「从上次带入」：拉该供货商最近一张单，勾选需要的行，没进的去掉即可；
 * 2. 「疑似重复商品」：输入时用本地相似度 + 建议接口双重检测，
 *    保存前再汇总确认一次，避免「粉丝 / 龙口粉丝 / 飞天粉丝」被记成三种。
 *
 * 手机档（<768）走卡片布局，字段节点与 PC 同一份，切换断点不丢已填内容。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, App as AntdApp, Button, Drawer, Modal } from 'antd';
import { ImeInput as Input } from '@/components/ImeInput';
import {
  SCALE,
  SHELF_LIFE_UNITS,
  type OrderView,
  type ProductNameItem,
  type RecordDraft,
  type RecordView,
  type ShelfLifeUnit,
} from '@stockin/shared';
import {
  applyFieldEvent,
  createInitialLinkageState,
  isValidISODate,
  type FieldEvent,
  type LinkageState,
} from '@stockin/domain';
import NumericInput from '@/components/NumericInput';
import DateInput from '@/components/DateInput';
import Icon from '@/components/Icon';
import SuggestionInput from '@/components/SuggestionInput';
import { buildRecordDraft, linkageFrom, validateRecordForm } from '@/components/RecordForm';
import { getRecordSuggestions, getProductNames } from '@/services/api/record';
import { getNextOrderNo, getOrder, listOrders } from '@/services/api/order';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { TOUCH_TARGET_MIN_PX } from '@/constants/routes';
import {
  formatMoney,
  formatQuantity,
  formatQuantityShort,
  formatUnitPrice,
  isDateString,
  SHORT_UNIT_LABELS,
} from '@/utils/format';
import { createIdempotencyKey } from '@/utils/idempotency-key';
import { errorMessage } from '@/services/request';

/* ------------------------------------------------------------------ 行模型 */

interface LineBase {
  name: string;
  spec: string;
  remark: string;
}

interface OriginSnapshot {
  readonly quantity: string;
  readonly unitPrice: string;
}

interface OrderLine {
  readonly key: string;
  readonly base: LineBase;
  readonly linkage: LinkageState;
  /** 从上一张单带过来的原始数量/单价，用于「改了几处」；本单新增的行为 null。 */
  readonly origin: OriginSnapshot | null;
}

let lineSeq = 0;
function nextKey(): string {
  lineSeq += 1;
  return `line-${lineSeq}`;
}

function emptyLine(): OrderLine {
  return {
    key: nextKey(),
    base: { name: '', spec: '', remark: '' },
    linkage: createInitialLinkageState(),
    origin: null,
  };
}

function lineFromRecord(view: RecordView): OrderLine {
  return {
    key: nextKey(),
    base: { name: view.name, spec: view.spec ?? '', remark: view.remark ?? '' },
    linkage: linkageFrom(view),
    origin: {
      quantity: formatQuantity(view.quantity),
      unitPrice: formatUnitPrice(view.unitPrice),
    },
  };
}

/* --------------------------------------------------------- 疑似重复商品检测 */

/** 编辑距离；长度差 >2 直接判为「差很远」，避免长名称无谓计算。 */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 2) return 3;
  const prev: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let diag: number = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const temp: number = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = temp;
    }
  }
  return prev[b.length];
}

/** 疑似重复：互为子串，或编辑距离 ≤1（少打/多打/打错一个字）。 */
function looksSimilar(input: string, candidate: string): boolean {
  const a: string = input.trim();
  const b: string = candidate.trim();
  if (a === '' || b === '' || a === b) return false;
  if (a.includes(b) || b.includes(a)) return true;
  return editDistance(a, b) <= 1;
}

/** 上海时区当天，YYYY-MM-DD。 */
function todayIso(): string {
  const shifted = new Date(Date.now() + 8 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ 组件 */

export interface OrderPayload {
  readonly supplier: string;
  readonly purchaseDate: string;
  readonly orderNo: string;
  readonly remark: string;
  readonly items: RecordDraft[];
  readonly idempotencyKey: string;
}

export interface OrderFormProps {
  readonly submitting: boolean;
  readonly onSubmit: (payload: OrderPayload) => Promise<void>;
  readonly onCancel: () => void;
}

const UNIT_OPTIONS: { value: ShelfLifeUnit; label: string }[] = SHELF_LIFE_UNITS.map(
  (unit) => ({ value: unit, label: SHORT_UNIT_LABELS[unit] }),
);

const OrderForm: React.FC<OrderFormProps> = ({ submitting, onSubmit, onCancel }) => {
  const { message: holderMessage } = AntdApp.useApp();
  const { isMobile } = useBreakpoint();

  const [supplier, setSupplier] = useState<string>('');
  const [purchaseDate, setPurchaseDate] = useState<string>((): string => todayIso());
  const [orderNo, setOrderNo] = useState<string>('');
  const [remark, setRemark] = useState<string>('');
  const [lines, setLines] = useState<OrderLine[]>((): OrderLine[] => [emptyLine()]);
  const [formError, setFormError] = useState<string | null>(null);

  /** 疑似重复检测用的历史商品名，进入页面拉一次。 */
  const [productNames, setProductNames] = useState<readonly ProductNameItem[]>([]);
  /** 当前行命中的相似商品（key → 候选）。 */
  const [similarOf, setSimilarOf] = useState<Readonly<Record<string, readonly ProductNameItem[]>>>({});

  /** 从上次带入。 */
  const [pickOpen, setPickOpen] = useState<boolean>(false);
  const [pickLoading, setPickLoading] = useState<boolean>(false);
  const [pickItems, setPickItems] = useState<readonly RecordView[]>([]);
  const [pickChecked, setPickChecked] = useState<readonly number[]>([]);
  const [pickSource, setPickSource] = useState<OrderView | null>(null);

  /** 保存前的「新商品」确认。 */
  const [confirmNewNames, setConfirmNewNames] = useState<readonly string[] | null>(null);
  const pendingPayload = useRef<OrderPayload | null>(null);

  useEffect((): void => {
    void getProductNames(500)
      .then((result): void => setProductNames(result.items))
      .catch((): void => undefined);
  }, []);

  /* 单号预填：拿不到就留空，交给服务端生成 */
  useEffect((): (() => void) => {
    let active = true;
    void getNextOrderNo(purchaseDate)
      .then((result): void => {
        if (active) setOrderNo(result.orderNo);
      })
      .catch((): void => undefined);
    return (): void => {
      active = false;
    };
  }, [purchaseDate]);

  const dispatch = useCallback((key: string, event: FieldEvent): void => {
    setLines((prev: OrderLine[]): OrderLine[] =>
      prev.map((line: OrderLine): OrderLine =>
        line.key === key ? { ...line, linkage: applyFieldEvent(line.linkage, event) } : line,
      ),
    );
  }, []);

  const patchBase = useCallback((key: string, p: Partial<LineBase>): void => {
    setLines((prev: OrderLine[]): OrderLine[] =>
      prev.map((line: OrderLine): OrderLine =>
        line.key === key ? { ...line, base: { ...line.base, ...p } } : line,
      ),
    );
  }, []);

  const removeLine = useCallback((key: string): void => {
    setLines((prev: OrderLine[]): OrderLine[] => {
      const next: OrderLine[] = prev.filter((line: OrderLine): boolean => line.key !== key);
      return next.length === 0 ? [emptyLine()] : next;
    });
  }, []);

  const addLine = useCallback((): void => {
    setLines((prev: OrderLine[]): OrderLine[] => [...prev, emptyLine()]);
  }, []);

  const clearSimilar = useCallback((key: string): void => {
    setSimilarOf((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  /* -------- 合计 -------- */
  const totals = useMemo((): { count: number; quantity: number; cents: number } => {
    let count = 0;
    let quantity = 0;
    let cents = 0;
    for (const line of lines) {
      if (line.base.name.trim() === '') continue;
      count += 1;
      quantity += line.linkage.amount.quantity.parsed ?? 0;
      cents += line.linkage.amount.amount.parsed ?? 0;
    }
    return { count, quantity, cents };
  }, [lines]);

  /** 与带入来源相比改了几处（只统计数量和单价这两项高频修改）。 */
  const changedCount: number = useMemo((): number => {
    let n = 0;
    for (const line of lines) {
      if (line.origin === null) continue;
      if (line.linkage.amount.quantity.raw !== line.origin.quantity) n += 1;
      if (line.linkage.amount.unitPrice.raw !== line.origin.unitPrice) n += 1;
    }
    return n;
  }, [lines]);

  const copiedCount: number = useMemo(
    (): number => lines.filter((line: OrderLine): boolean => line.origin !== null).length,
    [lines],
  );

  /* -------- 名称变更：相似检测 -------- */
  const onNameChange = useCallback(
    (line: OrderLine, value: string): void => {
      patchBase(line.key, { name: value });
      const text: string = value.trim();
      if (text === '') {
        clearSimilar(line.key);
        return;
      }
      const exact: boolean = productNames.some(
        (item: ProductNameItem): boolean => item.name === text,
      );
      if (exact) {
        clearSimilar(line.key);
        return;
      }
      const local: ProductNameItem[] = productNames
        .filter((item: ProductNameItem): boolean => looksSimilar(text, item.name))
        .slice(0, 3);
      if (local.length > 0) {
        setSimilarOf((prev) => ({ ...prev, [line.key]: local }));
        return;
      }
      setSimilarOf((prev) => ({ ...prev, [line.key]: [] }));
      /* 本地没命中时退回服务端包含匹配（历史名很多时更准） */
      const supplierName: string = supplier.trim();
      void getRecordSuggestions('name', text, supplierName === '' ? undefined : supplierName)
        .then((result): void => {
          const remote: ProductNameItem[] = result.items
            .filter((item): boolean => item.value !== text)
            .slice(0, 3)
            .map(
              (item): ProductNameItem => ({
                name: item.value,
                spec: item.spec,
                unitPrice: item.unitPrice,
                lastPurchaseDate: item.lastPurchaseDate ?? null,
              }),
            );
          if (remote.length > 0) setSimilarOf((prev) => ({ ...prev, [line.key]: remote }));
        })
        .catch((): void => undefined);
    },
    [clearSimilar, patchBase, productNames, supplier],
  );

  const applySimilar = useCallback(
    (line: OrderLine, item: ProductNameItem): void => {
      patchBase(line.key, { name: item.name });
      if (item.spec !== null && item.spec !== '') patchBase(line.key, { spec: item.spec });
      if (item.unitPrice !== null && item.unitPrice > 0) {
        dispatch(line.key, {
          type: 'userInput',
          slot: 'unitPrice',
          raw: formatUnitPrice(item.unitPrice),
          parsed: item.unitPrice,
        });
      }
      clearSimilar(line.key);
    },
    [clearSimilar, dispatch, patchBase],
  );

  /* -------- 从上次带入 -------- */
  const openPick = useCallback(async (): Promise<void> => {
    const name: string = supplier.trim();
    if (name === '') {
      holderMessage.warning('先填供货商，才能找到该供货商上次的单');
      return;
    }
    setPickOpen(true);
    setPickLoading(true);
    try {
      const page = await listOrders({ supplier: name, page: 1, pageSize: 1 });
      const last: OrderView | undefined = page.items[0];
      if (last === undefined) {
        setPickSource(null);
        setPickItems([]);
        setPickChecked([]);
        return;
      }
      const detail = await getOrder(last.id);
      setPickSource(last);
      setPickItems(detail.items);
      setPickChecked(detail.items.map((item: RecordView): number => item.id));
    } catch (cause) {
      holderMessage.error(errorMessage(cause, '读取上一张单失败'));
      setPickItems([]);
    } finally {
      setPickLoading(false);
    }
  }, [holderMessage, supplier]);

  const applyPick = useCallback((): void => {
    const picked: RecordView[] = pickItems.filter((item: RecordView): boolean =>
      pickChecked.includes(item.id),
    );
    if (picked.length === 0) {
      setPickOpen(false);
      return;
    }
    setLines((prev: OrderLine[]): OrderLine[] => {
      const kept: OrderLine[] = prev.filter(
        (line: OrderLine): boolean => line.base.name.trim() !== '',
      );
      return [...kept, ...picked.map(lineFromRecord)];
    });
    setPickOpen(false);
  }, [pickChecked, pickItems]);

  /* -------- 提交 -------- */
  const buildItems = useCallback((): { drafts: RecordDraft[]; error: string | null } => {
    const drafts: RecordDraft[] = [];
    for (const [index, line] of lines.entries()) {
      if (line.base.name.trim() === '') continue;
      const base = {
        name: line.base.name,
        purchaseDate,
        spec: line.base.spec,
        remark: line.base.remark,
      };
      const invalid: string | null = validateRecordForm(base, line.linkage);
      if (invalid !== null) {
        return { drafts: [], error: `第 ${index + 1} 行：${invalid}` };
      }
      drafts.push(buildRecordDraft(base, line.linkage, null));
    }
    return { drafts, error: null };
  }, [lines, purchaseDate]);

  const doSubmit = useCallback(async (): Promise<void> => {
    setFormError(null);
    if (supplier.trim() === '') {
      setFormError('请先填供货商');
      return;
    }
    if (!isDateString(purchaseDate) || !isValidISODate(purchaseDate)) {
      setFormError('进货日期格式不正确');
      return;
    }
    const { drafts, error } = buildItems();
    if (error !== null) {
      setFormError(error);
      return;
    }
    if (drafts.length === 0) {
      setFormError('至少填一个商品');
      return;
    }
    const payload: OrderPayload = {
      supplier: supplier.trim(),
      purchaseDate,
      orderNo: orderNo.trim(),
      remark: remark.trim(),
      items: drafts,
      /* 整单一个幂等键：重复点保存不会写出两张单 */
      idempotencyKey: createIdempotencyKey(),
    };

    /* 保存前汇总：本次出现了历史里没有的商品名 */
    const known: Set<string> = new Set(productNames.map((item: ProductNameItem): string => item.name));
    const fresh: string[] = Array.from(
      new Set(
        drafts
          .map((draft: RecordDraft): string => draft.name)
          .filter((name: string): boolean => known.size > 0 && !known.has(name)),
      ),
    );
    if (fresh.length > 0 && productNames.length > 0) {
      pendingPayload.current = payload;
      setConfirmNewNames(fresh);
      return;
    }
    await onSubmit(payload);
  }, [buildItems, onSubmit, orderNo, productNames, purchaseDate, remark, supplier]);

  /* -------- 单行字段：返回命名节点，两套布局共用 -------- */
  const cellsOf = (line: OrderLine, index: number): Record<string, React.ReactNode> => {
    const shelfUnit: ShelfLifeUnit = line.linkage.date.shelfLife.value?.unit ?? 'month';
    const shelfText: string =
      line.linkage.date.shelfLife.value !== null
        ? String(line.linkage.date.shelfLife.value.value)
        : '';
    const similar = similarOf[line.key] ?? [];
    const qtyChanged: boolean =
      line.origin !== null && line.linkage.amount.quantity.raw !== line.origin.quantity;
    const priceChanged: boolean =
      line.origin !== null && line.linkage.amount.unitPrice.raw !== line.origin.unitPrice;

    return {
      name: (
        <div className="stockin-order-cell stockin-order-cell--name">
          <span className="stockin-order-cell__label">商品名称</span>
          <SuggestionInput
            field="name"
            value={line.base.name}
            ariaLabel={`第 ${index + 1} 行商品名称`}
            placeholder="输入或从历史选"
            maxLength={200}
            onChange={(value: string): void => onNameChange(line, value)}
            onPick={(item): void => {
              patchBase(line.key, { name: item.value });
              if (item.spec !== null && item.spec !== '') patchBase(line.key, { spec: item.spec });
              if (item.unitPrice !== null && item.unitPrice > 0) {
                dispatch(line.key, {
                  type: 'userInput',
                  slot: 'unitPrice',
                  raw: formatUnitPrice(item.unitPrice),
                  parsed: item.unitPrice,
                });
              }
              clearSimilar(line.key);
            }}
          />
          {similar.length > 0 ? (
            <div className="stockin-similar">
              <div className="stockin-similar__head">
                <Icon name="alert" size="sm" />
                历史里有 {similar.length} 个相似商品
              </div>
              <div className="stockin-similar__opts">
                {similar.map(
                  (item: ProductNameItem): React.ReactNode => (
                    <button
                      key={item.name}
                      type="button"
                      className="stockin-similar__opt"
                      onClick={(): void => applySimilar(line, item)}
                    >
                      {item.name}
                      <small>
                        {item.unitPrice !== null ? ` ¥${formatUnitPrice(item.unitPrice)}` : ''}
                        {item.lastPurchaseDate !== null && item.lastPurchaseDate !== undefined
                          ? ` · ${String(item.lastPurchaseDate).slice(5)} 进过`
                          : ''}
                      </small>
                    </button>
                  ),
                )}
              </div>
            </div>
          ) : null}
        </div>
      ),
      spec: (
        <div className="stockin-order-cell">
          <span className="stockin-order-cell__label">规格</span>
          <SuggestionInput
            field="spec"
            value={line.base.spec}
            ariaLabel={`第 ${index + 1} 行规格`}
            placeholder="规格"
            maxLength={200}
            onChange={(value: string): void => patchBase(line.key, { spec: value })}
          />
        </div>
      ),
      productionDate: (
        <div className="stockin-order-cell">
          <span className="stockin-order-cell__label">生产日期</span>
          <DateInput
            value={line.linkage.date.productionDate.value ?? ''}
            ariaLabel={`第 ${index + 1} 行生产日期`}
            onChange={(next: string): void =>
              dispatch(line.key, { type: 'userInput', slot: 'productionDate', raw: next })
            }
          />
        </div>
      ),
      shelf: (
        <div className="stockin-order-cell stockin-order-cell--shelf">
          <span className="stockin-order-cell__label">保质期</span>
          <div className="stockin-input-group">
            <Input
              value={shelfText}
              inputMode="numeric"
              placeholder="数值"
              aria-label={`第 ${index + 1} 行保质期`}
              className="stockin-shelf-value"
              onChange={(event: React.ChangeEvent<HTMLInputElement>): void =>
                dispatch(line.key, {
                  type: 'userInput',
                  slot: 'shelfLife',
                  raw: event.target.value,
                  unit: shelfUnit,
                })
              }
            />
            <select
              className="stockin-shelf-unit"
              aria-label={`第 ${index + 1} 行保质期单位`}
              value={shelfUnit}
              onChange={(event: React.ChangeEvent<HTMLSelectElement>): void =>
                dispatch(line.key, {
                  type: 'userInput',
                  slot: 'shelfLife',
                  raw: shelfText,
                  unit: event.target.value as ShelfLifeUnit,
                })
              }
            >
              {UNIT_OPTIONS.map(
                (option): React.ReactNode => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ),
              )}
            </select>
          </div>
        </div>
      ),
      expiry: (
        <div className="stockin-order-cell stockin-order-cell--auto">
          <span className="stockin-order-cell__label">到期日 · 自动</span>
          <span className="stockin-order-auto">{line.linkage.date.expiryDate.value ?? '—'}</span>
        </div>
      ),
      unitPrice: (
        <div className={`stockin-order-cell stockin-order-cell--num${priceChanged ? ' is-changed' : ''}`}>
          <span className="stockin-order-cell__label">单价</span>
          <NumericInput
            raw={line.linkage.amount.unitPrice.raw}
            scale={SCALE.UNIT_PRICE}
            ariaLabel={`第 ${index + 1} 行单价`}
            placeholder="0.0000"
            onRawChange={(raw: string, parsed: number | null): void =>
              dispatch(line.key, { type: 'userInput', slot: 'unitPrice', raw, parsed })
            }
          />
        </div>
      ),
      quantity: (
        <div className={`stockin-order-cell stockin-order-cell--num${qtyChanged ? ' is-changed' : ''}`}>
          <span className="stockin-order-cell__label">数量</span>
          <NumericInput
            raw={line.linkage.amount.quantity.raw}
            scale={SCALE.QUANTITY}
            ariaLabel={`第 ${index + 1} 行数量`}
            placeholder="0.000"
            onRawChange={(raw: string, parsed: number | null): void =>
              dispatch(line.key, { type: 'userInput', slot: 'quantity', raw, parsed })
            }
          />
        </div>
      ),
      amount: (
        <div className="stockin-order-cell stockin-order-cell--num stockin-order-cell--auto">
          <span className="stockin-order-cell__label">金额 · 自动</span>
          <span className="stockin-order-auto">
            {formatMoney(line.linkage.amount.amount.parsed ?? 0)}
          </span>
        </div>
      ),
      remove: (
        <button
          type="button"
          className="stockin-order-del"
          aria-label={`删除第 ${index + 1} 行`}
          onClick={(): void => removeLine(line.key)}
        >
          <Icon name="close" size="sm" />
        </button>
      ),
    };
  };

  const renderRows = (): React.ReactNode => {
    const filled: OrderLine[] = lines;
    if (isMobile) {
      return (
        <div className="stockin-order-cards">
          {filled.map((line: OrderLine, index: number): React.ReactNode => {
            const c = cellsOf(line, index);
            const changed: boolean = line.origin !== null;
            return (
              <div key={line.key} className={`stockin-order-card-item${changed ? ' is-copied' : ''}`}>
                <div className="stockin-order-card-item__head">
                  {c.name}
                  {c.remove}
                </div>
                {c.spec}
                <div className="stockin-order-card-item__row3">
                  {c.quantity}
                  {c.unitPrice}
                  {c.amount}
                </div>
                <div className="stockin-order-card-item__row2">
                  {c.productionDate}
                  {c.shelf}
                </div>
                {c.expiry}
              </div>
            );
          })}
        </div>
      );
    }
    return (
      <div className="stockin-order-table">
        <div className="stockin-order-grid stockin-order-grid--head">
          <span>商品名称</span>
          <span>规格</span>
          <span>生产日期</span>
          <span>保质期</span>
          <span>到期日 · 自动</span>
          <span className="is-num">单价</span>
          <span className="is-num">数量</span>
          <span className="is-num">金额 · 自动</span>
          <span />
        </div>
        {filled.map((line: OrderLine, index: number): React.ReactNode => {
          const c = cellsOf(line, index);
          return (
            <div key={line.key} className="stockin-order-grid stockin-order-grid--row">
              {c.name}
              {c.spec}
              {c.productionDate}
              {c.shelf}
              {c.expiry}
              {c.unitPrice}
              {c.quantity}
              {c.amount}
              <div className="stockin-order-cell stockin-order-cell--del">{c.remove}</div>
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <form
      className="stockin-order-form"
      onSubmit={(event): void => {
        event.preventDefault();
        void doSubmit();
      }}
      noValidate
    >
      {formError !== null ? (
        <Alert
          type="error"
          showIcon
          message={formError}
          closable
          onClose={(): void => setFormError(null)}
          style={{ marginBottom: 16 }}
        />
      ) : null}

      <section className="stockin-form-section">
        <div className="stockin-form-section-head">
          <div className="stockin-form-section-heading">
            <h3>单据信息</h3>
          </div>
        </div>
        <div className="stockin-form-section-body">
          <div className="stockin-order-head-grid">
            <div className="stockin-field-wrap">
              <div className="stockin-field-label">
                <span>
                  供货商<span aria-hidden="true" style={{ color: 'var(--stockin-color-expired)' }}> *</span>
                </span>
              </div>
              <Input
                value={supplier}
                aria-label="供货商"
                placeholder="如：红星批发部"
                maxLength={100}
                onChange={(event: React.ChangeEvent<HTMLInputElement>): void =>
                  setSupplier(event.target.value)
                }
              />
            </div>
            <div className="stockin-field-wrap">
              <div className="stockin-field-label"><span>单据编号</span></div>
              <Input
                value={orderNo}
                aria-label="单据编号"
                placeholder="留空由系统生成"
                maxLength={40}
                onChange={(event: React.ChangeEvent<HTMLInputElement>): void =>
                  setOrderNo(event.target.value)
                }
              />
              <div className="stockin-hint">日期 + 当日序号，可改成纸质单上的号码</div>
            </div>
            <div className="stockin-field-wrap">
              <div className="stockin-field-label">
                <span>
                  进货日期<span aria-hidden="true" style={{ color: 'var(--stockin-color-expired)' }}> *</span>
                </span>
              </div>
              <DateInput value={purchaseDate} ariaLabel="进货日期" required onChange={setPurchaseDate} />
            </div>
            <div className="stockin-field-wrap">
              <div className="stockin-field-label"><span>整单备注</span></div>
              <Input
                value={remark}
                aria-label="整单备注"
                placeholder="如：含赠品 2 箱 / 赊账未结"
                maxLength={1000}
                onChange={(event: React.ChangeEvent<HTMLInputElement>): void =>
                  setRemark(event.target.value)
                }
              />
            </div>
          </div>
        </div>
      </section>

      <section className="stockin-form-section">
        <div className="stockin-form-section-head">
          <div className="stockin-form-section-heading">
            <h3>商品明细</h3>
            <span className="stockin-form-section-count">
              {totals.count} 个品种 · {formatQuantityShort(totals.quantity)} 件
            </span>
          </div>
          <div className="stockin-btn-row">
            <Button
              icon={<Icon name="layers" size="sm" />}
              onClick={(): void => void openPick()}
              style={{ minHeight: TOUCH_TARGET_MIN_PX }}
            >
              从上次带入
            </Button>
            <Button
              type="dashed"
              icon={<Icon name="plus" size="sm" />}
              onClick={addLine}
              style={{ minHeight: TOUCH_TARGET_MIN_PX }}
            >
              添加一行
            </Button>
          </div>
        </div>
        <div className="stockin-form-section-body is-flush">{renderRows()}</div>
        <div className="stockin-order-foot">
          <div className="stockin-order-foot__meta">
            {copiedCount > 0 ? (
              <span>
                含 {copiedCount} 行来自上一张单
                {changedCount > 0 ? ` · 已改 ${changedCount} 处` : ' · 未改动'}
              </span>
            ) : (
              <span>还没带入历史商品时，逐行新增即可</span>
            )}
          </div>
          <div className="stockin-order-foot__total">
            <span>合计</span>
            <b>{formatMoney(totals.cents)}</b>
          </div>
        </div>
      </section>

      <div className="stockin-submit-bar" style={{ justifyContent: 'flex-end' }}>
        <div className="stockin-btn-row">
          <Button onClick={onCancel} disabled={submitting} style={{ minHeight: TOUCH_TARGET_MIN_PX }}>
            取消
          </Button>
          <Button
            type="primary"
            htmlType="submit"
            loading={submitting}
            icon={<Icon name="check" size="sm" />}
            style={{ minHeight: TOUCH_TARGET_MIN_PX, minWidth: 132 }}
          >
            保存整单（{totals.count} 条）
          </Button>
        </div>
      </div>

      {/* 从上次带入 */}
      <Drawer
        open={pickOpen}
        onClose={(): void => setPickOpen(false)}
        placement={isMobile ? 'bottom' : 'right'}
        height={isMobile ? '72%' : undefined}
        width={isMobile ? undefined : 480}
        title="从上次带入"
        className="stockin-drawer"
        footer={
          <div className="stockin-btn-row" style={{ justifyContent: 'flex-end' }}>
            <Button onClick={(): void => setPickChecked([])}>全不选</Button>
            <Button
              type="primary"
              disabled={pickChecked.length === 0}
              onClick={applyPick}
              style={{ minHeight: TOUCH_TARGET_MIN_PX }}
            >
              带入所选 {pickChecked.length} 行
            </Button>
          </div>
        }
      >
        {pickLoading ? (
          <div className="stockin-hint">正在读取上一张单…</div>
        ) : pickSource === null ? (
          <div className="stockin-hint">该供货商还没有历史单据，先手动录入这一张。</div>
        ) : (
          <>
            <div className="stockin-pick-meta">
              {pickSource.supplier} · {pickSource.purchaseDate} · {pickSource.itemCount} 个品种
            </div>
            <div className="stockin-pick-list">
              {pickItems.map(
                (item: RecordView): React.ReactNode => (
                  <label key={item.id} className="stockin-pick-row">
                    <input
                      type="checkbox"
                      checked={pickChecked.includes(item.id)}
                      onChange={(event): void => {
                        const checked: boolean = event.target.checked;
                        setPickChecked((prev: readonly number[]): readonly number[] =>
                          checked
                            ? [...prev, item.id]
                            : prev.filter((id: number): boolean => id !== item.id),
                        );
                      }}
                    />
                    <span className="stockin-pick-row__name">{item.name}</span>
                    <span className="stockin-pick-row__meta">
                      {item.spec ?? '无规格'} · {formatQuantity(item.quantity)} 件 · ¥
                      {formatUnitPrice(item.unitPrice)}
                    </span>
                  </label>
                ),
              )}
            </div>
            <p className="stockin-hint" style={{ marginTop: 12 }}>
              这次没进的货，把勾去掉就不会进本单；日期不会跟着复制，请按实际填写。
            </p>
          </>
        )}
      </Drawer>

      {/* 保存前：疑似新商品确认 */}
      <Modal
        open={confirmNewNames !== null}
        title="确认新商品"
        okText="就是这个，继续保存"
        cancelText="返回修改"
        onCancel={(): void => {
          setConfirmNewNames(null);
          pendingPayload.current = null;
        }}
        onOk={(): void => {
          const payload: OrderPayload | null = pendingPayload.current;
          setConfirmNewNames(null);
          pendingPayload.current = null;
          if (payload !== null) void onSubmit(payload);
        }}
        okButtonProps={{ loading: submitting }}
      >
        <p style={{ marginTop: 0 }}>历史里没有这些商品名，确认是新商品而不是打错字：</p>
        <ul style={{ paddingLeft: 20, margin: '8px 0 0' }}>
          {(confirmNewNames ?? []).map(
            (name: string): React.ReactNode => (
              <li key={name} style={{ fontWeight: 600 }}>{name}</li>
            ),
          )}
        </ul>
      </Modal>
    </form>
  );
};

export default OrderForm;
