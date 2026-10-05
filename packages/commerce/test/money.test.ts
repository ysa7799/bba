import { ValidationError } from '@businessos/shared';
import { describe, expect, it } from 'vitest';
import {
  bpToPercent,
  computeLine,
  computeTotals,
  moneyView,
  parseUnitAmount,
  percentSchema,
  quantitySchema,
} from '../src/money';

describe('commercial arithmetic (integer minor units)', () => {
  it('computes BHD lines with 3 decimals, discounts and VAT without floats', () => {
    // 3 × BHD 12.345 = 37.035; 10% discount = 3.7035 → 3.704 (half up); VAT 10% of 33.331 → 3.333.
    const line = computeLine({
      quantity: '3',
      unitAmountMinor: parseUnitAmount('12.345', 'BHD', 'unit'),
      discountBp: 1000,
      taxRateBp: 1000,
    });
    expect(line).toEqual({
      subtotalMinor: 37_035n,
      discountMinor: 3_704n,
      taxMinor: 3_333n,
      totalMinor: 36_664n,
    });
    expect(moneyView(line.totalMinor, 'BHD')).toEqual({
      amountMinor: '36664',
      amount: '36.664',
      currency: 'BHD',
    });
  });

  it('handles fractional quantities and zero-decimal currencies', () => {
    expect(
      computeLine({ quantity: '1.5', unitAmountMinor: 333n, discountBp: 0, taxRateBp: 0 })
        .subtotalMinor,
    ).toBe(500n);
    expect(
      computeLine({
        quantity: '0.333',
        unitAmountMinor: parseUnitAmount('1000', 'JPY', 'u'),
        discountBp: 0,
        taxRateBp: 1000,
      }),
    ).toEqual({ subtotalMinor: 333n, discountMinor: 0n, taxMinor: 33n, totalMinor: 366n });
  });

  it('is exact where binary floating point is not', () => {
    // 0.1 + 0.2 style traps: 3 lines of USD 0.10 with 0.2 quantity add up exactly.
    const lines = Array.from({ length: 3 }, () =>
      computeLine({
        quantity: '0.2',
        unitAmountMinor: parseUnitAmount('0.10', 'USD', 'u'),
        discountBp: 0,
        taxRateBp: 0,
      }),
    );
    expect(computeTotals(lines).totalMinor).toBe(6n);
    // Large values stay exact (beyond Number.MAX_SAFE_INTEGER in intermediate products).
    const big = computeLine({
      quantity: '999999999.999',
      unitAmountMinor: 999_999_999_999_999n,
      discountBp: 1,
      taxRateBp: 10_000,
    });
    expect(big.subtotalMinor).toBe(999_999_999_998_999_000_000_000n);
    expect(() => computeTotals([big])).toThrow(ValidationError);
  });

  it('totals are the sums of rounded lines', () => {
    const lines = [
      computeLine({ quantity: '1', unitAmountMinor: 1_005n, discountBp: 0, taxRateBp: 500 }),
      computeLine({ quantity: '1', unitAmountMinor: 1_005n, discountBp: 0, taxRateBp: 500 }),
    ];
    // 5% of 1.005 = 0.05025 → 0.050 per line (half up at 3 decimals) → 0.100 in total.
    expect(lines[0]?.taxMinor).toBe(50n);
    expect(computeTotals(lines)).toEqual({
      subtotalMinor: 2_010n,
      discountMinor: 0n,
      taxMinor: 100n,
      totalMinor: 2_110n,
    });
  });

  it('validates amounts, quantities and percentages strictly', () => {
    expect(() => parseUnitAmount('1.2345', 'BHD', 'unit')).toThrow(ValidationError);
    expect(() => parseUnitAmount('1.234', 'USD', 'unit')).toThrow(ValidationError);
    expect(() => parseUnitAmount('-1', 'BHD', 'unit')).toThrow(ValidationError);
    expect(() => parseUnitAmount('1', 'XXX', 'unit')).toThrow(ValidationError);
    expect(() => parseUnitAmount('1e5', 'BHD', 'unit')).toThrow(ValidationError);
    expect(parseUnitAmount('0.005', 'BHD', 'unit')).toBe(5n);
    for (const bad of ['0', '-1', '1.2345', '1e3', 'abc', '']) {
      expect(quantitySchema.safeParse(bad).success, bad).toBe(false);
    }
    expect(percentSchema.parse('10')).toBe(1000);
    expect(percentSchema.parse('2.5')).toBe(250);
    expect(percentSchema.parse('15.75')).toBe(1575);
    expect(percentSchema.safeParse('100.01').success).toBe(false);
    expect(percentSchema.safeParse('1.234').success).toBe(false);
    expect(bpToPercent(1000)).toBe('10');
    expect(bpToPercent(250)).toBe('2.5');
    expect(bpToPercent(1575)).toBe('15.75');
  });
});
