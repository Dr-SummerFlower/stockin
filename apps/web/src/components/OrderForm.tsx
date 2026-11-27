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
  type ProductNameListResponse,
  type RecordDraft,
  type RecordView,
  type ShelfLifeUnit,
} from '@stockin/shared';
import {
  applyFieldEvent,
  createInitialLinkageState,
  isValidISODate,
  parseFixed,
  type FieldEvent,
  type LinkageState,
} from '@stockin/domain';
import NumericInput from '@/components/NumericInput';
import DateInput from '@/components/DateInput';
import Icon from '@/components/Icon';
import SuggestionInput from '@/components/SuggestionInput';
import {
  blockImplicitSubmit,
  buildRecordDraft,
  linkageFrom,
  validateRecordForm,
} from '@/components/RecordForm';
import { getRecordSuggestions, getProductNames } from '@/services/api/record';
import { getNextOrderNo, getOrder, listOrders } from '@/services/api/order';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { TOUCH_TARGET_MIN_PX } from '@/constants/routes';
import {
  formatCount,
  formatMoney,
  formatQuantity,
  formatQuantityShort,
  formatShelfLife,
  formatUnitPrice,
  isDateString,
  SHORT_UNIT_LABELS,
} from '@/utils/format';
import { createIdempotencyKey } from '@/utils/idempotency-key';
import { ApiError, errorMessage } from '@/services/request';

/* ------------------------------------------------------------------ 行模型 */

interface LineBase {
  name: string;
  spec: string;
  remark: string;
}

interface OriginSnapshot {
  readonly quantity: string;
  readonly unitPrice: string;
  readonly spec: string;
  readonly productionDate: string | null;
  readonly shelfLifeValue: number | null;
  readonly shelfLifeUnit: ShelfLifeUnit | null;
}

/** 一条明细上与「上一张单」的差异项。 */
interface LineChange {
  readonly field: 'quantity' | 'unitPrice' | 'spec' | 'productionDate' | 'shelfLife';
  readonly label: string;
  readonly from: string;
  readonly to: string;
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
      spec: view.spec ?? '',
      productionDate: view.productionDate,
      shelfLifeValue: view.shelfLifeValue,
      shelfLifeUnit: view.shelfLifeUnit,
    },
  };
}

/**
 * 历史商品（只有名称/规格/上次单价）→ 一行。
 * 数量与日期留空：这两项每批都不同，宁可让用户填，也不要带错。
 */
function lineFromProductName(item: ProductNameItem): OrderLine {
  const linkage: LinkageState =
    item.unitPrice !== null && item.unitPrice > 0
      ? applyFieldEvent(createInitialLinkageState(), {
          type: 'userInput',
          slot: 'unitPrice',
          raw: formatUnitPrice(item.unitPrice),
          parsed: item.unitPrice,
        })
      : createInitialLinkageState();
  return {
    key: nextKey(),
    base: { name: item.name, spec: item.spec ?? '', remark: '' },
    linkage,
    /* 不是从上一张单复制的行，不参与「与上一张单相比」 */
    origin: null,
  };
}

/** 去掉定点小数多余的尾零：`"5.000"` → `"5"`、`"34.8000"` → `"34.8"`。 */
function trimZeros(text: string): string {
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
}

/** 数值文本归一化：`"6"` 与 `"6.000"` 视为同一个值。 */
function sameNumber(a: string, b: string): boolean {
  const na: number = Number.parseFloat(a);
  const nb: number = Number.parseFloat(b);
  if (!Number.isFinite(na) && !Number.isFinite(nb)) return true;
  if (!Number.isFinite(na) || !Number.isFinite(nb)) return false;
  return Math.abs(na - nb) < 1e-9;
}

/** 逐字段比对：只报「从上一张单带过来、且被改过」的项。 */
function lineChanges(line: OrderLine): LineChange[] {
  const o: OriginSnapshot | null = line.origin;
  if (o === null) return [];
  const changes: LineChange[] = [];

  if (!sameNumber(line.linkage.amount.quantity.raw, o.quantity)) {
    changes.push({
      field: 'quantity',
      label: '数量',
      from: o.quantity === '' ? '—' : trimZeros(o.quantity),
      to:
        line.linkage.amount.quantity.raw === ''
          ? '—'
          : trimZeros(line.linkage.amount.quantity.raw),
    });
  }
  if (!sameNumber(line.linkage.amount.unitPrice.raw, o.unitPrice)) {
    changes.push({
      field: 'unitPrice',
      label: '单价',
      from: o.unitPrice === '' ? '—' : trimZeros(o.unitPrice),
      to:
        line.linkage.amount.unitPrice.raw === ''
          ? '—'
          : trimZeros(line.linkage.amount.unitPrice.raw),
    });
  }
  if ((line.base.spec ?? '') !== o.spec) {
    changes.push({
      field: 'spec',
      label: '规格',
      from: o.spec === '' ? '—' : o.spec,
      to: line.base.spec === '' ? '—' : line.base.spec,
    });
  }
  const currentProd: string = line.linkage.date.productionDate.value ?? '';
  if (currentProd !== (o.productionDate ?? '')) {
    changes.push({
      field: 'productionDate',
      label: '生产日期',
      from: o.productionDate ?? '—',
      to: currentProd === '' ? '—' : currentProd,
    });
  }
  const currentShelf: { value: string; unit: ShelfLifeUnit } = {
    value:
      line.linkage.date.shelfLife.value === null
        ? ''
        : String(line.linkage.date.shelfLife.value.value),
    unit: line.linkage.date.shelfLife.value?.unit ?? 'month',
  };
  if (
    !sameNumber(currentShelf.value, o.shelfLifeValue === null ? '' : String(o.shelfLifeValue)) ||
    (currentShelf.value !== '' && currentShelf.unit !== (o.shelfLifeUnit ?? 'month'))
  ) {
    changes.push({
      field: 'shelfLife',
      label: '保质期',
      from: formatShelfLife(o.shelfLifeValue, o.shelfLifeUnit),
      to:
        currentShelf.value === ''
          ? '—'
          : formatShelfLife(Number(currentShelf.value), currentShelf.unit),
    });
  }
  return changes;
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

/**
 * 从保存失败里取「第几条明细出错」（0 基）与**具体原因**。
 *
 * 服务端 `VALID_FAILED` 的顶层 message 是固定文案「请求数据校验失败」，真正原因在
 * `details.reason`（Service 逐条校验）或 `details.issues[].message`（zValidator）。
 * 两者都读，否则用户只会看到「第 N 条：请求数据校验失败」（06-P1-2）。
 */
function orderSubmitError(error: unknown): { index: number | null; reason: string } | null {
  if (!(error instanceof ApiError)) return null;
  const details = error.details as {
    index?: unknown;
    reason?: unknown;
    issues?: readonly { message?: unknown }[] | null;
  } | null;
  const index: number | null =
    typeof details?.index === 'number' && Number.isInteger(details.index) && details.index >= 0
      ? details.index
      : null;
  let reason: string =
    typeof details?.reason === 'string' && details.reason !== '' ? details.reason : '';
  if (reason === '' && Array.isArray(details?.issues)) {
    const first: string | undefined = details?.issues?.find(
      (issue): boolean => typeof issue.message === 'string' && issue.message !== '',
    )?.message as string | undefined;
    reason = first ?? '';
  }
  return { index, reason: reason === '' ? error.message : reason };
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

/**
 * 保存前确认。
 *
 * - `new`：清单正常，历史里没有这些名字；
 * - `similar`：清单失败，兜底查到与历史相似的名字；
 * - `unverified`：清单失败且兜底也没查到，无法完成重名校验。
 */
interface NewNameConfirm {
  readonly names: readonly string[];
  readonly kind: 'new' | 'similar' | 'unverified';
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
  /**
   * 单号是否被用户手改过。
   *
   * 手改成纸质单号后再改进货日期，不能被接口返回值冲掉（04-F-02）。
   * 用 ref 而不是 state：只做「能不能覆盖」的判定，不需要重渲染。
   */
  const orderNoTouched = useRef<boolean>(false);
  /** 服务端指明的出错明细（按行 key 记录，行增删不会错位）。 */
  const [errorKey, setErrorKey] = useState<string | null>(null);
  /** 行节点索引，用于滚动定位到出错行。 */
  const rowRefs = useRef<Record<string, HTMLDivElement | null>>({});

  useEffect((): void => {
    if (errorKey === null) return;
    rowRefs.current[errorKey]?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  }, [errorKey]);

  /** 疑似重复检测用的历史商品名，进入页面拉一次。 */
  const [productNames, setProductNames] = useState<readonly ProductNameItem[]>([]);
  /**
   * 商品名清单是否已成功加载。
   *
   * 初始 false：清单未就绪或加载失败时，保存前必须走建议接口兜底并给出可见确认，
   * 不能把「拿不到清单」误判成「历史确实为空」而静默落库（06-D-01）。
   */
  const [productNamesReady, setProductNamesReady] = useState<boolean>(false);
  /** 当前行命中的相似商品（key → 候选）。 */
  const [similarOf, setSimilarOf] = useState<Readonly<Record<string, readonly ProductNameItem[]>>>({});

  /** 从上次带入。 */
  const [pickOpen, setPickOpen] = useState<boolean>(false);
  const [pickLoading, setPickLoading] = useState<boolean>(false);
  const [pickItems, setPickItems] = useState<readonly RecordView[]>([]);
  const [pickChecked, setPickChecked] = useState<readonly number[]>([]);
  const [pickSource, setPickSource] = useState<OrderView | null>(null);
  /** 第二组：这家供货商进过、但上一张单里没有的商品（按供货商取的商品名清单）。 */
  const [extraPicks, setExtraPicks] = useState<readonly ProductNameItem[]>([]);
  const [extraChecked, setExtraChecked] = useState<readonly string[]>([]);
  /** 底部「与上一张单相比」是否展开。 */
  const [diffOpen, setDiffOpen] = useState<boolean>(false);
  /** 新追加行的 key：渲染完成后把焦点移到它的商品名（Tab 续行）。 */
  const [focusKey, setFocusKey] = useState<string | null>(null);

  /** 保存前的「新商品」确认（或清单失败时的未校验提示）。 */
  const [confirmNewNames, setConfirmNewNames] = useState<NewNameConfirm | null>(null);
  const pendingPayload = useRef<OrderPayload | null>(null);

  useEffect((): void => {
    void getProductNames(500)
      .then((result): void => {
        setProductNames(result.items);
        setProductNamesReady(true);
      })
      .catch((): void => {
        setProductNamesReady(false);
      });
  }, []);

  /* 单号预填：拿不到就留空，交给服务端生成；用户手改过就不再覆盖 */
  useEffect((): (() => void) => {
    let active = true;
    void getNextOrderNo(purchaseDate)
      .then((result): void => {
        if (active && !orderNoTouched.current) setOrderNo(result.orderNo);
      })
      .catch((): void => undefined);
    return (): void => {
      active = false;
    };
  }, [purchaseDate]);

  const dispatch = useCallback((key: string, event: FieldEvent): void => {
    // 改动了出错行就撤掉它的高亮，避免「已经改好还红着」。
    setErrorKey((prev: string | null): string | null => (prev === key ? null : prev));
    setLines((prev: OrderLine[]): OrderLine[] =>
      prev.map((line: OrderLine): OrderLine =>
        line.key === key ? { ...line, linkage: applyFieldEvent(line.linkage, event) } : line,
      ),
    );
  }, []);

  const patchBase = useCallback((key: string, p: Partial<LineBase>): void => {
    setErrorKey((prev: string | null): string | null => (prev === key ? null : prev));
    setLines((prev: OrderLine[]): OrderLine[] =>
      prev.map((line: OrderLine): OrderLine =>
        line.key === key ? { ...line, base: { ...line.base, ...p } } : line,
      ),
    );
  }, []);

  const removeLine = useCallback((key: string): void => {
    // 删掉出错行后不能再高亮它（06-P2-22）。
    setErrorKey((prev: string | null): string | null => (prev === key ? null : prev));
    setLines((prev: OrderLine[]): OrderLine[] => {
      const next: OrderLine[] = prev.filter((line: OrderLine): boolean => line.key !== key);
      return next.length === 0 ? [emptyLine()] : next;
    });
  }, []);

  /**
   * 追加一行并返回新行 key。
   * key 必须同步拿到，才能在下一帧把焦点放过去（Tab 续行靠它）。
   */
  const appendLine = useCallback((): string => {
    const line: OrderLine = emptyLine();
    setLines((prev: OrderLine[]): OrderLine[] => [...prev, line]);
    return line.key;
  }, []);

  /** 「添加一行」按钮：追加并聚焦新行商品名，省一次点击。 */
  const addLine = useCallback((): void => {
    setFocusKey(appendLine());
  }, [appendLine]);

  /* 焦点转移必须在 DOM 提交之后做，否则新行还不存在。 */
  useEffect((): void => {
    if (focusKey === null) return;
    const input: HTMLInputElement | null = document.querySelector<HTMLInputElement>(
      `[data-line-key="${focusKey}"] .stockin-order-cell--name input`,
    );
    input?.focus();
    setFocusKey(null);
  }, [focusKey, lines]);

  const clearSimilar = useCallback((key: string): void => {
    setSimilarOf((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  /** 单字段还原到「上一张单」的值。 */
  const restoreField = useCallback(
    (line: OrderLine, field: LineChange['field']): void => {
      const o: OriginSnapshot | null = line.origin;
      if (o === null) return;
      if (field === 'quantity') {
        dispatch(line.key, {
          type: 'userInput',
          slot: 'quantity',
          raw: trimZeros(o.quantity),
          parsed: parseFixed(o.quantity, SCALE.QUANTITY),
        });
        return;
      }
      if (field === 'unitPrice') {
        dispatch(line.key, {
          type: 'userInput',
          slot: 'unitPrice',
          raw: trimZeros(o.unitPrice),
          parsed: parseFixed(o.unitPrice, SCALE.UNIT_PRICE),
        });
        return;
      }
      if (field === 'spec') {
        patchBase(line.key, { spec: o.spec });
        return;
      }
      if (field === 'productionDate') {
        dispatch(line.key, {
          type: 'userInput',
          slot: 'productionDate',
          raw: o.productionDate ?? '',
        });
        return;
      }
      dispatch(line.key, {
        type: 'userInput',
        slot: 'shelfLife',
        raw: o.shelfLifeValue === null ? '' : String(o.shelfLifeValue),
        unit: o.shelfLifeUnit ?? 'month',
      });
    },
    [dispatch, patchBase],
  );

  /** 手机档步进：按「1 件」为步长，负数钳到 0。 */
  const stepQuantity = useCallback(
    (line: OrderLine, delta: number): void => {
      const current: number = line.linkage.amount.quantity.parsed ?? 0;
      const next: number = Math.max(0, current + delta * SCALE.QUANTITY);
      dispatch(line.key, {
        type: 'userInput',
        slot: 'quantity',
        raw: formatQuantityShort(next),
        parsed: next,
      });
    },
    [dispatch],
  );

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

  /** 与上一张单相比的逐行、逐字段差异（数量/单价/规格/生产日期/保质期）。 */
  const changeGroups = useMemo(
    (): { line: OrderLine; name: string; items: LineChange[] }[] =>
      lines
        .map(
          (line: OrderLine): { line: OrderLine; name: string; items: LineChange[] } => ({
            line,
            name: line.base.name,
            items: lineChanges(line),
          }),
        )
        /* 名称被清空的行视为已删除，不参与差异统计 */
        .filter(
          (group): boolean => group.items.length > 0 && group.name.trim() !== '',
        ),
    [lines],
  );

  const changedCount: number = useMemo(
    (): number =>
      changeGroups.reduce((sum: number, group): number => sum + group.items.length, 0),
    [changeGroups],
  );

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
        setExtraPicks([]);
        setExtraChecked([]);
        return;
      }
      /*
       * 候选清单按供货商取：只列这家进过的，别家的货不进候选。
       * 拉不到就当没有候选（静默降级）——它只是补货提示，不该挡住「带入上次」。
       */
      const detail = await getOrder(last.id);
      const historyNames: ProductNameListResponse = await getProductNames(500, name).catch(
        (): ProductNameListResponse => ({ items: [] }),
      );
      setPickSource(last);
      setPickItems(detail.items);
      setPickChecked(detail.items.map((item: RecordView): number => item.id));

      /*
       * 第二组：这家进过、但上一张单里没有的商品。
       * 数量与日期一律留空 —— 这两项每批都不同，宁可让人填也不要带错。
       */
      const inLastOrder = new Set(detail.items.map((item: RecordView): string => item.name));
      const inForm = new Set(
        lines
          .map((line: OrderLine): string => line.base.name.trim())
          .filter((item: string): boolean => item !== ''),
      );
      setExtraPicks(
        historyNames.items
          .filter(
            (item: ProductNameItem): boolean =>
              !inLastOrder.has(item.name) && !inForm.has(item.name),
          )
          .slice(0, 8),
      );
      setExtraChecked([]);
    } catch (cause) {
      holderMessage.error(errorMessage(cause, '读取上一张单失败'));
      setPickItems([]);
      setExtraPicks([]);
      setExtraChecked([]);
    } finally {
      setPickLoading(false);
    }
  }, [holderMessage, lines, supplier]);

  const applyPick = useCallback((): void => {
    const picked: RecordView[] = pickItems.filter((item: RecordView): boolean =>
      pickChecked.includes(item.id),
    );
    const pickedExtras: ProductNameItem[] = extraPicks.filter(
      (item: ProductNameItem): boolean => extraChecked.includes(item.name),
    );
    if (picked.length === 0 && pickedExtras.length === 0) {
      setPickOpen(false);
      return;
    }
    // 整批带入会替换行集合，旧错误高亮不再对应任何行（06-P2-22）。
    setErrorKey(null);
    setLines((prev: OrderLine[]): OrderLine[] => {
      const kept: OrderLine[] = prev.filter(
        (line: OrderLine): boolean => line.base.name.trim() !== '',
      );
      return [
        ...kept,
        ...picked.map(lineFromRecord),
        ...pickedExtras.map(lineFromProductName),
      ];
    });
    setPickOpen(false);
  }, [extraChecked, extraPicks, pickChecked, pickItems]);

  /* -------- 提交 -------- */
  const buildItems = useCallback((): { drafts: RecordDraft[]; error: string | null } => {
    const drafts: RecordDraft[] = [];
    for (const line of lines) {
      if (line.base.name.trim() === '') continue;
      const base = {
        name: line.base.name,
        purchaseDate,
        spec: line.base.spec,
        remark: line.base.remark,
      };
      const invalid: string | null = validateRecordForm(base, line.linkage);
      if (invalid !== null) {
        // 用过滤空行后的序号（drafts.length + 1），与服务端 details.index 的口径一致（06-P2-13）。
        return { drafts: [], error: `第 ${drafts.length + 1} 行：${invalid}` };
      }
      drafts.push(buildRecordDraft(base, line.linkage, null));
    }
    return { drafts, error: null };
  }, [lines, purchaseDate]);

  /**
   * 真正提交：统一处理服务端 422。
   *
   * `details.index` 指明第几条明细出错时，把该行标红并滚动到位，
   * 顶部 Alert 同时给出「第 N 条：原因」（04-F-01）。
   */
  const submit = useCallback(
    async (payload: OrderPayload): Promise<void> => {
      try {
        await onSubmit(payload);
      } catch (cause) {
        const info: { index: number | null; reason: string } | null = orderSubmitError(cause);
        if (info !== null && info.index !== null) {
          const filled: OrderLine[] = lines.filter(
            (line: OrderLine): boolean => line.base.name.trim() !== '',
          );
          setErrorKey(filled[info.index]?.key ?? null);
          setFormError(`第 ${info.index + 1} 条：${info.reason}`);
          return;
        }
        setFormError(info?.reason ?? errorMessage(cause, '保存失败'));
      }
    },
    [lines, onSubmit],
  );

  const doSubmit = useCallback(async (): Promise<void> => {
    setFormError(null);
    setErrorKey(null);
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

    /* 保存前汇总：本次出现了历史里没有的商品名（06-D-01）。
     *
     * 清单加载成功时用本地清单；未就绪/加载失败时逐个走建议接口兜底，
     * 兜底也失败则进入「未校验」确认，绝不静默落库。 */
    const names: string[] = Array.from(
      new Set(drafts.map((draft: RecordDraft): string => draft.name)),
    );

    if (productNamesReady) {
      const known: Set<string> = new Set(
        productNames.map((item: ProductNameItem): string => item.name),
      );
      /* known 为空表示历史确实为空，此时不提示、按原样保存 */
      const fresh: string[] = names.filter(
        (name: string): boolean => known.size > 0 && !known.has(name),
      );
      if (fresh.length > 0) {
        pendingPayload.current = payload;
        setConfirmNewNames({ names: fresh, kind: 'new' });
        return;
      }
    } else {
      /* 清单未就绪/加载失败：逐个走建议接口兜底。
       * 注意服务端是「包含匹配」，无法覆盖编辑距离类相似名；
       * 因此只要清单不可用，就必须显式确认，绝不静默落库（06-D-01）。 */
      const supplierName: string = supplier.trim();
      const similar: string[] = [];
      for (const name of names) {
        try {
          const result = await getRecordSuggestions(
            'name',
            name,
            supplierName === '' ? undefined : supplierName,
          );
          if (result.items.some((item): boolean => item.value !== name)) {
            similar.push(name);
          }
        } catch {
          /* 建议接口也失败：仍按「未校验」处理，下面统一走显式确认 */
        }
      }
      pendingPayload.current = payload;
      setConfirmNewNames({
        names: similar.length > 0 ? similar : names,
        kind: similar.length > 0 ? 'similar' : 'unverified',
      });
      return;
    }
    await submit(payload);
  }, [
    buildItems,
    orderNo,
    productNames,
    productNamesReady,
    purchaseDate,
    remark,
    submit,
    supplier,
  ]);

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
                        {/* 候选 chip 是「念给人听」的位置，两位小数即可；定长 4 位只用于表格对齐 */}
                        {item.unitPrice !== null
                          ? ` ¥${(item.unitPrice / 10000).toFixed(2)}`
                          : ''}
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
            placeholder="如：500g/袋、1箱=12瓶"
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
        <div className="stockin-order-cell">
          <span className="stockin-order-cell__label">到期日</span>
          <DateInput
            value={line.linkage.date.expiryDate.value ?? ''}
            ariaLabel={`第 ${index + 1} 行到期日`}
            onChange={(next: string): void =>
              dispatch(line.key, { type: 'userInput', slot: 'expiryDate', raw: next })
            }
          />
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
        <div
          className={`stockin-order-cell stockin-order-cell--num stockin-order-cell--qty${qtyChanged ? ' is-changed' : ''}`}
          onKeyDown={(event: React.KeyboardEvent<HTMLDivElement>): void => {
            /* 末行数量按 Tab：补一行并把焦点送到新行的商品名。
               数量是金额组里最常被连续录入的字段，保留它作为快捷续行点。 */
            if (event.key !== 'Tab' || event.shiftKey) return;
            if (index !== lines.length - 1) return;
            if (line.base.name.trim() === '') return;
            event.preventDefault();
            setFocusKey(appendLine());
          }}
        >
          <span className="stockin-order-cell__label">数量</span>
          {isMobile ? (
            <div className="stockin-stepper">
              <button
                type="button"
                aria-label={`第 ${index + 1} 行数量减一`}
                onClick={(): void => stepQuantity(line, -1)}
              >
                −
              </button>
              <NumericInput
                raw={line.linkage.amount.quantity.raw}
                scale={SCALE.QUANTITY}
                ariaLabel={`第 ${index + 1} 行数量`}
                placeholder="0"
                onRawChange={(raw: string, parsed: number | null): void =>
                  dispatch(line.key, { type: 'userInput', slot: 'quantity', raw, parsed })
                }
              />
              <button
                type="button"
                aria-label={`第 ${index + 1} 行数量加一`}
                onClick={(): void => stepQuantity(line, 1)}
              >
                +
              </button>
            </div>
          ) : (
            <NumericInput
              raw={line.linkage.amount.quantity.raw}
              scale={SCALE.QUANTITY}
              ariaLabel={`第 ${index + 1} 行数量`}
              placeholder="0.000"
              onRawChange={(raw: string, parsed: number | null): void =>
                dispatch(line.key, { type: 'userInput', slot: 'quantity', raw, parsed })
              }
            />
          )}
        </div>
      ),
      amount: (
        <div className="stockin-order-cell stockin-order-cell--num">
          <span className="stockin-order-cell__label">金额</span>
          <NumericInput
            raw={line.linkage.amount.amount.raw}
            scale={SCALE.AMOUNT_CENTS}
            ariaLabel={`第 ${index + 1} 行金额`}
            placeholder="0.00"
            addonBefore="¥"
            onRawChange={(raw: string, parsed: number | null): void =>
              dispatch(line.key, { type: 'userInput', slot: 'amount', raw, parsed })
            }
          />
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
            const isError: boolean = errorKey === line.key;
            return (
              <div
                key={line.key}
                ref={(node: HTMLDivElement | null): void => {
                  rowRefs.current[line.key] = node;
                }}
                className={`stockin-order-card-item${changed ? ' is-copied' : ''}${isError ? ' is-error' : ''}`}
                data-line-key={line.key}
              >
                <div className="stockin-order-card-item__head">
                  {c.name}
                  {c.remove}
                </div>
                {c.spec}
                <div className="stockin-order-card-item__amounts">
                  <div className="stockin-order-card-item__row2">
                    {c.unitPrice}
                    {c.amount}
                  </div>
                  {c.quantity}
                </div>
                <div className="stockin-order-card-item__dates">
                  <div className="stockin-order-card-item__row2">
                    {c.productionDate}
                    {c.expiry}
                  </div>
                  {c.shelf}
                </div>
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
          <span>到期日</span>
          <span className="is-num">单价</span>
          <span className="is-num">数量</span>
          <span className="is-num">金额</span>
          <span />
        </div>
        {filled.map((line: OrderLine, index: number): React.ReactNode => {
          const c = cellsOf(line, index);
          const isError: boolean = errorKey === line.key;
          return (
            <div
              key={line.key}
              ref={(node: HTMLDivElement | null): void => {
                rowRefs.current[line.key] = node;
              }}
              className={`stockin-order-grid stockin-order-grid--row${isError ? ' is-error' : ''}`}
              data-line-key={line.key}
            >
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
      // 明细行里按回车（含日期弹层确认）不应把整单提交掉。
      onKeyDown={blockImplicitSubmit}
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

      {/* F-07：手机端滚动录 20 行时仍能看见当前品种 / 件数 / 合计。 */}
      <div className="stockin-order-sticky-sum" aria-live="polite">
        <span>{formatCount(totals.count)} 个品种</span>
        <span>{formatQuantityShort(totals.quantity)} 件</span>
        <b>{formatMoney(totals.cents)}</b>
      </div>

      <section className="stockin-form-section">
        <div className="stockin-form-section-head" data-tour-id="order-basic">
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
                onChange={(event: React.ChangeEvent<HTMLInputElement>): void => {
                  const next: string = event.target.value;
                  // 清空视为「交回系统生成」，改进货日期时重新自动带号。
                  orderNoTouched.current = next.trim() !== '';
                  setOrderNo(next);
                }}
              />
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
              <>
                <span>含 {copiedCount} 行来自上一张单</span>
                {changedCount > 0 ? (
                  <button
                    type="button"
                    className="stockin-diff-toggle"
                    aria-expanded={diffOpen}
                    onClick={(): void => setDiffOpen((open: boolean): boolean => !open)}
                  >
                    已改 {changedCount} 处 · {diffOpen ? '收起' : '看改了什么'}
                  </button>
                ) : (
                  <span className="stockin-order-foot__calm">未改动</span>
                )}
              </>
            ) : null}
          </div>
          <div className="stockin-order-foot__total">
            <span>合计</span>
            <b>{formatMoney(totals.cents)}</b>
          </div>
        </div>
        {diffOpen && changeGroups.length > 0 ? (
          <div className="stockin-diff-panel">
            {changeGroups.map(
              (group): React.ReactNode => (
                <div key={group.line.key} className="stockin-diff-group">
                  <div className="stockin-diff-group__name">{group.name}</div>
                  {group.items.map(
                    (item): React.ReactNode => (
                      <div key={item.field} className="stockin-diff-row">
                        <span className="stockin-diff-row__label">{item.label}</span>
                        <span className="stockin-diff-row__old">{item.from}</span>
                        <span className="stockin-diff-row__arrow" aria-hidden="true">→</span>
                        <span className="stockin-diff-row__new">{item.to}</span>
                        <button
                          type="button"
                          className="stockin-diff-row__undo"
                          onClick={(): void => restoreField(group.line, item.field)}
                        >
                          还原
                        </button>
                      </div>
                    ),
                  )}
                </div>
              ),
            )}
          </div>
        ) : null}
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
            <Button
              onClick={(): void => {
                /* 两组都要清：只清第一组会留下已勾的候选，主按钮仍可点，容易带进没打算要的行 */
                setPickChecked([]);
                setExtraChecked([]);
              }}
            >
              全不选
            </Button>
            <Button
              type="primary"
              disabled={pickChecked.length + extraChecked.length === 0}
              onClick={applyPick}
              style={{ minHeight: TOUCH_TARGET_MIN_PX }}
            >
              带入所选 {pickChecked.length + extraChecked.length} 行
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
                      {/* 与第二组、详情页同一口径：数量去尾零、单价两位，别在这里出现 6.000 / ¥34.8000 */}
                      {item.spec ?? '无规格'} · {formatQuantityShort(item.quantity)} 件 · ¥
                      {(item.unitPrice / 10000).toFixed(2)}
                    </span>
                  </label>
                ),
              )}
            </div>
            <p className="stockin-hint" style={{ marginTop: 12 }}>
              这次没进的货，把勾去掉就不会进本单；日期不会跟着复制，请按实际填写。
            </p>
            {extraPicks.length > 0 ? (
              <div className="stockin-pick-extra">
                <div className="stockin-pick-extra__head">
                  这家上次没带、以前进过
                  <span>勾上一起带入，数量留空</span>
                </div>
                {extraPicks.map(
                  (item: ProductNameItem): React.ReactNode => (
                    <label key={item.name} className="stockin-pick-row">
                      <input
                        type="checkbox"
                        checked={extraChecked.includes(item.name)}
                        onChange={(event): void => {
                          const checked: boolean = event.target.checked;
                          setExtraChecked((prev: readonly string[]): readonly string[] =>
                            checked
                              ? [...prev, item.name]
                              : prev.filter((name: string): boolean => name !== item.name),
                          );
                        }}
                      />
                      <span className="stockin-pick-row__name">{item.name}</span>
                      <span className="stockin-pick-row__meta">
                        {item.spec ?? '无规格'}
                        {item.unitPrice !== null
                          ? ` · ¥${(item.unitPrice / 10000).toFixed(2)}`
                          : ''}
                        {item.lastPurchaseDate !== null && item.lastPurchaseDate !== undefined
                          ? ` · ${item.lastPurchaseDate.slice(5)} 进过`
                          : ''}
                      </span>
                    </label>
                  ),
                )}
              </div>
            ) : null}
          </>
        )}
      </Drawer>

      {/* 保存前：疑似新商品确认 / 清单失败时的未校验确认 */}
      <Modal
        open={confirmNewNames !== null}
        title={
          confirmNewNames?.kind === 'unverified'
            ? '未能校验商品名'
            : confirmNewNames?.kind === 'similar'
              ? '商品名与历史相似'
              : '确认新商品'
        }
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
          if (payload !== null) void submit(payload);
        }}
        okButtonProps={{ loading: submitting }}
      >
        <p style={{ marginTop: 0 }}>
          {confirmNewNames?.kind === 'unverified'
            ? '商品名清单加载失败，未能重名校验；确认以下商品名无误后继续：'
            : confirmNewNames?.kind === 'similar'
              ? '商品名清单加载失败，但这些名字与历史相似；确认是否打错：'
              : '历史里没有这些商品名，确认是新商品而不是打错字：'}
        </p>
        <ul style={{ paddingLeft: 20, margin: '8px 0 0' }}>
          {(confirmNewNames?.names ?? []).map(
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
