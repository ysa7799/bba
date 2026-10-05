import { z } from 'zod';
import { UnprocessableError, ValidationError } from './errors';

/**
 * Money is represented as integer minor units (bigint) plus an explicit ISO 4217 currency.
 * Never use JavaScript floating point numbers for monetary values.
 *
 * Exponents follow ISO 4217. Bahrain (BHD) and several regional currencies use 3 decimals.
 */
export const CURRENCY_EXPONENTS = {
  // Gulf / MENA
  BHD: 3,
  KWD: 3,
  OMR: 3,
  JOD: 3,
  IQD: 3,
  LYD: 3,
  TND: 3,
  SAR: 2,
  AED: 2,
  QAR: 2,
  EGP: 2,
  MAD: 2,
  // International
  USD: 2,
  EUR: 2,
  GBP: 2,
  CHF: 2,
  CAD: 2,
  AUD: 2,
  INR: 2,
  PKR: 2,
  CNY: 2,
  SGD: 2,
  TRY: 2,
  JPY: 0,
  KRW: 0,
} as const satisfies Record<string, number>;

export type CurrencyCode = keyof typeof CURRENCY_EXPONENTS;

export const SUPPORTED_CURRENCIES = Object.keys(CURRENCY_EXPONENTS) as CurrencyCode[];

/** Upper bound on |amount| in minor units; well inside Postgres bigint range. */
export const MAX_ABS_MINOR = 10n ** 17n;

export function isCurrencyCode(value: unknown): value is CurrencyCode {
  return typeof value === 'string' && Object.hasOwn(CURRENCY_EXPONENTS, value);
}

export function currencyExponent(currency: CurrencyCode): number {
  return CURRENCY_EXPONENTS[currency];
}

export interface Money {
  readonly amountMinor: bigint;
  readonly currency: CurrencyCode;
}

export type RoundingMode = 'half_even' | 'half_up' | 'floor' | 'ceil' | 'truncate';

export class CurrencyMismatchError extends UnprocessableError {
  constructor(a: CurrencyCode, b: CurrencyCode) {
    super(`Currency mismatch: ${a} vs ${b}. Currencies are never converted implicitly.`);
  }
}

function assertInRange(amountMinor: bigint): void {
  if (amountMinor > MAX_ABS_MINOR || amountMinor < -MAX_ABS_MINOR) {
    throw new UnprocessableError('Monetary amount is out of the supported range');
  }
}

export function money(amountMinor: bigint, currency: CurrencyCode): Money {
  if (!isCurrencyCode(currency)) {
    throw new ValidationError(`Unsupported currency`);
  }
  assertInRange(amountMinor);
  return Object.freeze({ amountMinor, currency });
}

export function zero(currency: CurrencyCode): Money {
  return money(0n, currency);
}

const DECIMAL_PATTERN = /^(-)?(\d{1,18})(?:\.(\d{1,18}))?$/;

/**
 * Parses a decimal string ("12.345") into Money. Rejects more fraction digits than the
 * currency allows instead of silently rounding.
 */
export function parseMoney(decimal: string, currency: CurrencyCode): Money {
  if (!isCurrencyCode(currency)) {
    throw new ValidationError('Unsupported currency');
  }
  const match = DECIMAL_PATTERN.exec(decimal.trim());
  if (!match) {
    throw new ValidationError('Invalid monetary amount', [
      { path: 'amount', message: 'Must be a decimal string such as "12.500"' },
    ]);
  }
  const [, sign, whole = '0', fraction = ''] = match;
  const exponent = currencyExponent(currency);
  if (fraction.length > exponent) {
    throw new ValidationError('Invalid monetary amount', [
      {
        path: 'amount',
        message: `${currency} allows at most ${exponent} decimal places`,
      },
    ]);
  }
  const minor =
    BigInt(whole) * 10n ** BigInt(exponent) + BigInt(fraction.padEnd(exponent, '0') || '0');
  return money(sign ? -minor : minor, currency);
}

/** Formats Money as a plain decimal string with exactly the currency's exponent digits. */
export function formatDecimal(value: Money): string {
  const exponent = currencyExponent(value.currency);
  const negative = value.amountMinor < 0n;
  const abs = negative ? -value.amountMinor : value.amountMinor;
  const digits = abs.toString().padStart(exponent + 1, '0');
  const whole = exponent === 0 ? digits : digits.slice(0, -exponent);
  const fraction = exponent === 0 ? '' : `.${digits.slice(-exponent)}`;
  return `${negative ? '-' : ''}${whole}${fraction}`;
}

/** Wire representation used by the API. */
export interface MoneyJson {
  amount: string;
  currency: CurrencyCode;
}

export function toMoneyJson(value: Money): MoneyJson {
  return { amount: formatDecimal(value), currency: value.currency };
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new CurrencyMismatchError(a.currency, b.currency);
  }
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amountMinor + b.amountMinor, a.currency);
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amountMinor - b.amountMinor, a.currency);
}

export function negate(a: Money): Money {
  return money(-a.amountMinor, a.currency);
}

export function compare(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b);
  if (a.amountMinor === b.amountMinor) return 0;
  return a.amountMinor < b.amountMinor ? -1 : 1;
}

export function equals(a: Money, b: Money): boolean {
  return a.currency === b.currency && a.amountMinor === b.amountMinor;
}

export function isZero(a: Money): boolean {
  return a.amountMinor === 0n;
}

export function isNegative(a: Money): boolean {
  return a.amountMinor < 0n;
}

export function sum(values: readonly Money[], currency: CurrencyCode): Money {
  let total = 0n;
  for (const value of values) {
    if (value.currency !== currency) {
      throw new CurrencyMismatchError(currency, value.currency);
    }
    total += value.amountMinor;
  }
  return money(total, currency);
}

/** Integer division with an explicit rounding mode. */
export function divRound(numerator: bigint, denominator: bigint, mode: RoundingMode): bigint {
  if (denominator === 0n) {
    throw new UnprocessableError('Division by zero');
  }
  let n = numerator;
  let d = denominator;
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const quotient = n / d; // truncates toward zero
  const remainder = n % d;
  if (remainder === 0n) return quotient;

  const negative = n < 0n;
  const awayFromZero = negative ? quotient - 1n : quotient + 1n;
  const twiceRemainder = (remainder < 0n ? -remainder : remainder) * 2n;

  switch (mode) {
    case 'truncate':
      return quotient;
    case 'floor':
      return negative ? quotient - 1n : quotient;
    case 'ceil':
      return negative ? quotient : quotient + 1n;
    case 'half_up':
      return twiceRemainder >= d ? awayFromZero : quotient;
    case 'half_even':
      if (twiceRemainder > d) return awayFromZero;
      if (twiceRemainder < d) return quotient;
      return quotient % 2n === 0n ? quotient : awayFromZero;
  }
}

/** Multiplies by the rational number numerator/denominator, rounding the result. */
export function multiplyByRatio(
  value: Money,
  numerator: bigint,
  denominator: bigint,
  rounding: RoundingMode = 'half_even',
): Money {
  return money(divRound(value.amountMinor * numerator, denominator, rounding), value.currency);
}

const FACTOR_PATTERN = /^(-)?(\d{1,12})(?:\.(\d{1,9}))?$/;

/** Parses a decimal factor (e.g. a quantity "1.5" or a rate "10") into a rational. */
export function parseDecimalRatio(factor: string): { numerator: bigint; denominator: bigint } {
  const match = FACTOR_PATTERN.exec(factor.trim());
  if (!match) {
    throw new ValidationError('Invalid decimal number', [
      { path: 'factor', message: 'Must be a decimal string' },
    ]);
  }
  const [, sign, whole = '0', fraction = ''] = match;
  const denominator = 10n ** BigInt(fraction.length);
  const numerator = BigInt(whole) * denominator + BigInt(fraction || '0');
  return { numerator: sign ? -numerator : numerator, denominator };
}

/** value × factor, where factor is a decimal string such as a quantity "2.5". */
export function multiplyByDecimal(
  value: Money,
  factor: string,
  rounding: RoundingMode = 'half_even',
): Money {
  const { numerator, denominator } = parseDecimalRatio(factor);
  return multiplyByRatio(value, numerator, denominator, rounding);
}

/** value × percent / 100, where percent is a decimal string such as "10" or "2.5". */
export function percentage(
  value: Money,
  percent: string,
  rounding: RoundingMode = 'half_even',
): Money {
  const { numerator, denominator } = parseDecimalRatio(percent);
  return multiplyByRatio(value, numerator, denominator * 100n, rounding);
}

/**
 * Splits an amount across integer weights without losing or creating minor units
 * (largest-remainder method; ties go to earlier entries).
 */
export function allocate(value: Money, weights: readonly number[]): Money[] {
  if (weights.length === 0) {
    throw new UnprocessableError('Cannot allocate across zero weights');
  }
  const big = weights.map((weight) => {
    if (!Number.isSafeInteger(weight) || weight < 0) {
      throw new UnprocessableError('Allocation weights must be non-negative integers');
    }
    return BigInt(weight);
  });
  const totalWeight = big.reduce((acc, weight) => acc + weight, 0n);
  if (totalWeight === 0n) {
    throw new UnprocessableError('Allocation weights must not all be zero');
  }
  const negative = value.amountMinor < 0n;
  const amount = negative ? -value.amountMinor : value.amountMinor;

  const shares = big.map((weight) => (amount * weight) / totalWeight);
  const remainders = big.map((weight, index) => ({
    index,
    remainder: (amount * weight) % totalWeight,
  }));
  let leftover = amount - shares.reduce((acc, share) => acc + share, 0n);
  remainders.sort((a, b) =>
    a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
  );
  for (const entry of remainders) {
    if (leftover === 0n) break;
    shares[entry.index] = (shares[entry.index] ?? 0n) + 1n;
    leftover -= 1n;
  }
  return shares.map((share) => money(negative ? -share : share, value.currency));
}

export const currencyCodeSchema = z
  .string()
  .transform((value) => value.toUpperCase())
  .refine(isCurrencyCode, { message: 'Unsupported currency' });

/** Zod schema for API money input: `{ amount: "12.500", currency: "BHD" }`. */
export const moneyInputSchema = z
  .object({
    amount: z.string().max(40),
    currency: currencyCodeSchema,
  })
  .transform((input, ctx) => {
    try {
      return parseMoney(input.amount, input.currency);
    } catch (error) {
      ctx.addIssue({
        code: 'custom',
        path: ['amount'],
        message:
          error instanceof ValidationError
            ? (error.details?.[0]?.message ?? error.message)
            : 'Invalid monetary amount',
      });
      return z.NEVER;
    }
  });
