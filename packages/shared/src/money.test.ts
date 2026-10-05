import { describe, expect, it } from 'vitest';
import {
  add,
  allocate,
  compare,
  CurrencyMismatchError,
  divRound,
  formatDecimal,
  money,
  moneyInputSchema,
  multiplyByDecimal,
  parseMoney,
  percentage,
  subtract,
  sum,
  toMoneyJson,
} from './money';
import { ValidationError } from './errors';

describe('money: BHD (3 decimals)', () => {
  it('parses and formats with three decimal places', () => {
    const value = parseMoney('12.345', 'BHD');
    expect(value.amountMinor).toBe(12345n);
    expect(formatDecimal(value)).toBe('12.345');
    expect(formatDecimal(parseMoney('12.3', 'BHD'))).toBe('12.300');
    expect(formatDecimal(parseMoney('0.005', 'BHD'))).toBe('0.005');
    expect(formatDecimal(parseMoney('-0.5', 'BHD'))).toBe('-0.500');
    expect(formatDecimal(parseMoney('7', 'BHD'))).toBe('7.000');
  });

  it('rejects more fraction digits than the currency allows instead of rounding', () => {
    expect(() => parseMoney('1.2345', 'BHD')).toThrow(ValidationError);
    expect(() => parseMoney('1.234', 'USD')).toThrow(ValidationError);
    expect(() => parseMoney('1.5', 'JPY')).toThrow(ValidationError);
  });

  it('rejects malformed input', () => {
    for (const bad of ['', 'abc', '1,000', '1e3', '.5', '1.', '--1', ' 1 2']) {
      expect(() => parseMoney(bad, 'BHD')).toThrow(ValidationError);
    }
  });

  it('avoids floating point drift (0.1 + 0.2)', () => {
    const total = add(parseMoney('0.100', 'BHD'), parseMoney('0.200', 'BHD'));
    expect(formatDecimal(total)).toBe('0.300');
  });

  it('never mixes currencies implicitly', () => {
    expect(() => add(parseMoney('1', 'BHD'), parseMoney('1', 'USD'))).toThrow(
      CurrencyMismatchError,
    );
    expect(() => compare(parseMoney('1', 'BHD'), parseMoney('1', 'SAR'))).toThrow(
      CurrencyMismatchError,
    );
    expect(() => sum([parseMoney('1', 'BHD'), parseMoney('1', 'AED')], 'BHD')).toThrow(
      CurrencyMismatchError,
    );
  });

  it('handles zero-exponent currencies', () => {
    expect(formatDecimal(parseMoney('1500', 'JPY'))).toBe('1500');
  });

  it('subtracts into negatives correctly', () => {
    expect(formatDecimal(subtract(parseMoney('1.000', 'BHD'), parseMoney('2.505', 'BHD')))).toBe(
      '-1.505',
    );
  });
});

describe('rounding', () => {
  it('rounds half-even (banker rounding)', () => {
    expect(divRound(5n, 2n, 'half_even')).toBe(2n);
    expect(divRound(7n, 2n, 'half_even')).toBe(4n);
    expect(divRound(-5n, 2n, 'half_even')).toBe(-2n);
    expect(divRound(-7n, 2n, 'half_even')).toBe(-4n);
    expect(divRound(10n, 3n, 'half_even')).toBe(3n);
    expect(divRound(11n, 3n, 'half_even')).toBe(4n);
  });

  it('rounds half-up away from zero', () => {
    expect(divRound(5n, 2n, 'half_up')).toBe(3n);
    expect(divRound(-5n, 2n, 'half_up')).toBe(-3n);
  });

  it('supports floor, ceil and truncate', () => {
    expect(divRound(-7n, 2n, 'floor')).toBe(-4n);
    expect(divRound(-7n, 2n, 'ceil')).toBe(-3n);
    expect(divRound(-7n, 2n, 'truncate')).toBe(-3n);
    expect(divRound(7n, -2n, 'floor')).toBe(-4n);
  });
});

describe('multiplication and percentages', () => {
  it('multiplies by fractional quantities', () => {
    expect(formatDecimal(multiplyByDecimal(parseMoney('1.999', 'BHD'), '3'))).toBe('5.997');
    expect(formatDecimal(multiplyByDecimal(parseMoney('10.000', 'BHD'), '1.5'))).toBe('15.000');
    expect(formatDecimal(multiplyByDecimal(parseMoney('0.333', 'BHD'), '0.5'))).toBe('0.166');
  });

  it('computes Bahrain VAT (10%) on BHD with three decimals', () => {
    expect(formatDecimal(percentage(parseMoney('12.345', 'BHD'), '10'))).toBe('1.234');
    expect(formatDecimal(percentage(parseMoney('12.355', 'BHD'), '10'))).toBe('1.236');
    expect(formatDecimal(percentage(parseMoney('100.000', 'BHD'), '2.5'))).toBe('2.500');
  });
});

describe('allocate', () => {
  it('splits without losing minor units', () => {
    const parts = allocate(parseMoney('10.000', 'BHD'), [1, 1, 1]);
    expect(parts.map(formatDecimal)).toEqual(['3.334', '3.333', '3.333']);
    expect(sum(parts, 'BHD').amountMinor).toBe(10000n);
  });

  it('respects weights and negative amounts', () => {
    const parts = allocate(money(-100n, 'USD'), [1, 3]);
    expect(parts.map((part) => part.amountMinor)).toEqual([-25n, -75n]);
  });

  it('rejects invalid weights', () => {
    expect(() => allocate(money(100n, 'USD'), [])).toThrow();
    expect(() => allocate(money(100n, 'USD'), [0, 0])).toThrow();
    expect(() => allocate(money(100n, 'USD'), [-1, 2])).toThrow();
  });
});

describe('range and schema', () => {
  it('rejects out-of-range amounts', () => {
    expect(() => money(10n ** 18n, 'BHD')).toThrow();
  });

  it('parses API input', () => {
    const parsed = moneyInputSchema.parse({ amount: '5.250', currency: 'bhd' });
    expect(parsed).toEqual({ amountMinor: 5250n, currency: 'BHD' });
    expect(toMoneyJson(parsed)).toEqual({ amount: '5.250', currency: 'BHD' });
  });

  it('rejects unsupported currencies and invalid precision in API input', () => {
    expect(moneyInputSchema.safeParse({ amount: '5', currency: 'XYZ' }).success).toBe(false);
    expect(moneyInputSchema.safeParse({ amount: '5.2501', currency: 'BHD' }).success).toBe(false);
    expect(moneyInputSchema.safeParse({ amount: 5.25, currency: 'BHD' }).success).toBe(false);
  });
});
