/**
 * 领域层公共类型。
 *
 * 依据：设计文档 v1.1 §5.1（领域层零 IO、零框架、零时钟，today 由调用方注入）、
 * §5.1「数值输入用 raw/parsed 双态」、§10.1 裁决 14。
 */
import type { FieldSource, LinkageSlot, ShelfLifeUnit } from '@stockin/shared';

/** 服务器本地自然日 YYYY-MM-DD；本层绝不自行读取系统时钟。 */
export type Today = string;

/** 保质期槽位的值（数值 + 单位成对）。 */
export interface ShelfLifeValue {
  readonly value: number;
  readonly unit: ShelfLifeUnit;
}

/** 单字段状态：值 + 来源三态。 */
export interface FieldState<T> {
  readonly value: T | null;
  readonly source: FieldSource;
}

/**
 * 通用三槽组状态。用于表达「三选二」组并校验不变量（每组至多 1 个 AUTO）。
 */
export interface GroupState<T> {
  readonly slots: readonly [FieldState<T>, FieldState<T>, FieldState<T>];
}

/** 数值槽的 raw/parsed 双态，避免 `"0."` 等中间态被误判为 0。 */
export interface NumericFieldState {
  readonly raw: string;
  readonly parsed: number | null;
  readonly source: FieldSource;
}

/** 日期组：生产日期 / 保质期 / 到期日期。 */
export interface DateGroupState {
  productionDate: FieldState<string>;
  shelfLife: FieldState<ShelfLifeValue>;
  expiryDate: FieldState<string>;
  /** 用户覆盖过 AUTO 值后锁定，整组不再自动推导（覆盖后不再重算）。 */
  locked: boolean;
}

/** 金额组：单价 / 数量 / 金额。 */
export interface AmountGroupState {
  unitPrice: NumericFieldState;
  quantity: NumericFieldState;
  amount: NumericFieldState;
  locked: boolean;
}

/** 6 个联动槽位的完整表单状态。 */
export interface LinkageState {
  readonly date: DateGroupState;
  readonly amount: AmountGroupState;
}

/** 用户输入事件（全同步，引擎不产生事件）。 */
export type FieldEvent =
  | {
      readonly type: 'userInput';
      readonly slot: LinkageSlot;
      readonly raw: string;
      readonly parsed?: number | null;
      readonly unit?: ShelfLifeUnit | null;
    }
  | {
      readonly type: 'userClear';
      readonly slot: LinkageSlot;
    };
