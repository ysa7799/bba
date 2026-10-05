import { describe, expect, it } from 'vitest';
import { formatMoney, humanize } from './format';

describe('formatMoney', () => {
  it('keeps exact decimal digits (3 for BHD) and groups thousands', () => {
    expect(formatMoney({ amount: '12500.250', currency: 'BHD' })).toBe('BHD 12,500.250');
    expect(formatMoney({ amount: '1234567.89', currency: 'SAR' })).toBe('SAR 1,234,567.89');
    expect(formatMoney({ amount: '0.001', currency: 'KWD' })).toBe('KWD 0.001');
    expect(formatMoney({ amount: '-5', currency: 'JPY' })).toBe('-JPY 5');
  });
});

describe('humanize', () => {
  it('turns keys into labels', () => {
    expect(humanize('multi_select')).toBe('Multi select');
  });
});
