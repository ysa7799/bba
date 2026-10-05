import {
  currencyExponent,
  divRound,
  formatDecimal,
  isCurrencyCode,
  MAX_ABS_MINOR,
  money,
  parseDecimalRatio,
  parseMoney,
  ValidationError,
  type CurrencyCode,
} from '@businessos/shared';
import { z } from 'zod';

/**
 * Commercial document arithmetic. Everything is integer minor units (`bigint`) in the
 * document's currency; quantities and percentages are exact decimals. Each line is rounded on
 * its own (half up, the usual commercial rule) and totals are sums of rounded lines, so the
 * printed lines always add up to the printed totals.
 */

/** Up to 999,999,999.999 units with at most three decimals. */
export const quantitySchema = z
  .string()
  .trim()
  .regex(/^\d{1,9}(\.\d{1,3})?$/, 'Use a number with up to 3 decimals')
  .refine((value) => Number(value) > 0, 'Must be more than zero');

/** A percentage with up to two decimals (0–100), stored as basis points (10% = 1000). */
export const percentSchema = z
  .string()
  .trim()
  .regex(/^\d{1,3}(\.\d{1,2})?$/, 'Use a percentage with up to 2 decimals')
  .transform((value) => {
    const { numerator, denominator } = parseDecimalRatio(value);
    return Number((numerator * 100n) / denominator);
  })
  .refine((bp) => bp <= 10_000, 'At most 100%');

export function bpToPercent(bp: number): string {
  const whole = Math.trunc(bp / 100);
  const fraction = bp % 100;
  return fraction === 0
    ? String(whole)
    : `${whole}.${String(fraction).padStart(2, '0').replace(/0$/, '')}`;
}

/** Largest unit price accepted (keeps every product of quantity × price within bigint). */
const MAX_UNIT_MINOR = 10n ** 15n;

/** Parses a decimal amount ("12.500") in a currency into minor units. */
export function parseUnitAmount(amount: string, currency: string, path: string): bigint {
  if (!isCurrencyCode(currency)) {
    throw new ValidationError('Unsupported currency', [
      { path: 'currency', message: 'Unsupported currency' },
    ]);
  }
  let parsed;
  try {
    parsed = parseMoney(amount, currency);
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    const exponent = currencyExponent(currency);
    throw new ValidationError('Invalid amount', [
      { path, message: `Use a number with up to ${exponent} decimals for ${currency}` },
    ]);
  }
  if (parsed.amountMinor < 0n || parsed.amountMinor > MAX_UNIT_MINOR) {
    throw new ValidationError('Invalid amount', [{ path, message: 'Out of range' }]);
  }
  return parsed.amountMinor;
}

export interface LinePricing {
  quantity: string;
  unitAmountMinor: bigint;
  discountBp: number;
  taxRateBp: number;
}

export interface LineAmounts {
  subtotalMinor: bigint;
  discountMinor: bigint;
  taxMinor: bigint;
  totalMinor: bigint;
}

export function computeLine(input: LinePricing): LineAmounts {
  const { numerator, denominator } = parseDecimalRatio(input.quantity);
  const subtotalMinor = divRound(input.unitAmountMinor * numerator, denominator, 'half_up');
  const discountMinor = divRound(subtotalMinor * BigInt(input.discountBp), 10_000n, 'half_up');
  const taxable = subtotalMinor - discountMinor;
  const taxMinor = divRound(taxable * BigInt(input.taxRateBp), 10_000n, 'half_up');
  return { subtotalMinor, discountMinor, taxMinor, totalMinor: taxable + taxMinor };
}

export interface DocumentTotals {
  subtotalMinor: bigint;
  discountMinor: bigint;
  taxMinor: bigint;
  totalMinor: bigint;
}

export function computeTotals(lines: readonly LineAmounts[]): DocumentTotals {
  const totals = lines.reduce(
    (sum, line) => ({
      subtotalMinor: sum.subtotalMinor + line.subtotalMinor,
      discountMinor: sum.discountMinor + line.discountMinor,
      taxMinor: sum.taxMinor + line.taxMinor,
      totalMinor: sum.totalMinor + line.totalMinor,
    }),
    { subtotalMinor: 0n, discountMinor: 0n, taxMinor: 0n, totalMinor: 0n },
  );
  if (totals.totalMinor > MAX_ABS_MINOR) {
    throw new ValidationError('The total is too large', [
      { path: 'lines', message: 'Total out of range' },
    ]);
  }
  return totals;
}

/** `{ amountMinor, amount, currency }` for API responses (never a float). */
export interface MoneyView {
  amountMinor: string;
  amount: string;
  currency: string;
}

export function moneyView(amountMinor: bigint, currency: string): MoneyView {
  return {
    amountMinor: amountMinor.toString(),
    amount: formatDecimal(money(amountMinor, currency as CurrencyCode)),
    currency,
  };
}
