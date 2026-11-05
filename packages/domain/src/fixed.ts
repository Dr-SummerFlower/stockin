/**
 * 整数定点运算（HALF_UP），全程 BigInt，零浮点累加、零 NaN/Infinity。
 *
 * 依据：设计文档 v1.1 §2.4 BR-2、§4.3（金额分 1e2 / 单价 1e4 / 数量 1e3）、
 * §5.1（除零不执行）、§8.3 核心用例 2「3.3333 × 3 = 10.00」。
 */

/** 断言安全整数，防止把浮点或越界值带入定点运算。 */
function assertSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`[fixed] ${label} 必须是安全整数，收到: ${String(value)}`);
  }
}

function assertPositiveScale(value: number, label: string): void {
  assertSafeInteger(value, label);
  if (value <= 0) {
    throw new RangeError(`[fixed] ${label} 必须 > 0，收到: ${value}`);
  }
}

/** BigInt 结果转回 number，越界则抛错而不是静默丢精度。 */
function toSafeNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError('[fixed] 运算结果超出安全整数范围');
  }
  return Number(value);
}

/**
 * HALF_UP 整数除法：floor(n/d + 0.5)，负数向远离零方向舍入。
 * denominator 为 0 时抛错（除零不执行，绝不产生 NaN/Infinity）。
 */
function halfUpDivide(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) {
    throw new RangeError('[fixed] 除零不执行');
  }
  const negative: boolean = (numerator < 0n) !== (denominator < 0n);
  const absN: bigint = numerator < 0n ? -numerator : numerator;
  const absD: bigint = denominator < 0n ? -denominator : denominator;
  const quotient: bigint = (absN * 2n + absD) / (2n * absD);
  return negative ? -quotient : quotient;
}

/** HALF_UP 取整除法（公开，便于自测与复用）。 */
export function fixedRound(numerator: number, denominator: number): number {
  assertSafeInteger(numerator, 'numerator');
  assertSafeInteger(denominator, 'denominator');
  if (denominator === 0) {
    throw new RangeError('[fixed] 除零不执行');
  }
  return toSafeNumber(halfUpDivide(BigInt(numerator), BigInt(denominator)));
}

/**
 * 定点乘法：已知 a、b 各自的倍率，求目标倍率下的整数结果。
 *
 * result = HALF_UP( aScaled × bScaled × scaleResult / (scaleA × scaleB) )
 *
 * @param aScaled 第一个操作数（已按 scaleA 放大）
 * @param bScaled 第二个操作数（已按 scaleB 放大）
 * @param scaleResult 结果的定点倍率
 */
export function fixedMul(
  aScaled: number,
  bScaled: number,
  scaleA: number,
  scaleB: number,
  scaleResult: number,
): number {
  assertSafeInteger(aScaled, 'aScaled');
  assertSafeInteger(bScaled, 'bScaled');
  assertPositiveScale(scaleA, 'scaleA');
  assertPositiveScale(scaleB, 'scaleB');
  assertPositiveScale(scaleResult, 'scaleResult');

  const numerator: bigint = BigInt(aScaled) * BigInt(bScaled) * BigInt(scaleResult);
  const denominator: bigint = BigInt(scaleA) * BigInt(scaleB);
  return toSafeNumber(halfUpDivide(numerator, denominator));
}

/**
 * 定点除法。除数为 0 时**直接返回 null**（不执行运算、不产生 NaN/Infinity）。
 *
 * result = HALF_UP( numeratorScaled × scaleDenominator × scaleResult
 *                   / (scaleNumerator × denominatorScaled) )
 */
export function fixedDiv(
  numeratorScaled: number,
  denominatorScaled: number,
  scaleNumerator: number,
  scaleDenominator: number,
  scaleResult: number,
): number | null {
  assertSafeInteger(numeratorScaled, 'numeratorScaled');
  assertSafeInteger(denominatorScaled, 'denominatorScaled');
  assertPositiveScale(scaleNumerator, 'scaleNumerator');
  assertPositiveScale(scaleDenominator, 'scaleDenominator');
  assertPositiveScale(scaleResult, 'scaleResult');

  if (denominatorScaled === 0) {
    return null;
  }

  const numerator: bigint =
    BigInt(numeratorScaled) * BigInt(scaleDenominator) * BigInt(scaleResult);
  const denominator: bigint = BigInt(scaleNumerator) * BigInt(denominatorScaled);
  return toSafeNumber(halfUpDivide(numerator, denominator));
}

/**
 * 把人类可读数字文本解析为定点整数（HALF_UP）。
 * `"0."` / `"-"` / 空串等输入中间态返回 null，供 raw/parsed 双态使用。
 *
 * @param value 单元格或输入框文本
 * @param scale 目标倍率（10 的整数次幂）
 */
export function parseFixed(value: string | number | null | undefined, scale: number): number | null {
  assertPositiveScale(scale, 'scale');
  if (value === null || value === undefined) {
    return null;
  }
  const text: string = typeof value === 'number' ? (Number.isFinite(value) ? String(value) : '') : value;
  const trimmed: string = text.trim();
  if (trimmed === '' || trimmed.endsWith('.') || trimmed.endsWith('+') || trimmed.endsWith('-')) {
    return null;
  }
  const match: RegExpExecArray | null = /^([+-]?)(\d*)(?:\.(\d+))?$/.exec(trimmed);
  if (match === null) {
    return null;
  }
  const sign: bigint = match[1] === '-' ? -1n : 1n;
  const intPart: string = match[2] ?? '';
  const fracPart: string = match[3] ?? '';
  if (intPart === '' && fracPart === '') {
    return null;
  }
  const digits: string = `${intPart === '' ? '0' : intPart}${fracPart}`;
  const numerator: bigint = sign * BigInt(digits) * BigInt(scale);
  const denominator: bigint = 10n ** BigInt(fracPart.length);
  return toSafeNumber(halfUpDivide(numerator, denominator));
}

/** 定点整数 → 人类可读文本（按倍率补足小数位）。 */
export function formatFixed(scaled: number, scale: number): string {
  assertSafeInteger(scaled, 'scaled');
  assertPositiveScale(scale, 'scale');
  const negative: boolean = scaled < 0;
  const abs: bigint = BigInt(Math.abs(scaled));
  const divisor: bigint = BigInt(scale);
  const intPart: bigint = abs / divisor;
  const fracPart: bigint = abs % divisor;
  const width: number = String(scale).length - 1;
  let text: string = String(intPart);
  if (width > 0) {
    text += `.${String(fracPart).padStart(width, '0')}`;
  }
  return negative ? `-${text}` : text;
}
