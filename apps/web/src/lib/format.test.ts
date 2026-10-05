import { describe, expect, it } from 'vitest';
import { formatBytes, formatMoney, humanize } from './format';

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

describe('formatBytes', () => {
  it('uses binary units with one decimal below ten', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1,023 B');
    expect(formatBytes(2560)).toBe('2.5 KB');
    expect(formatBytes('10485760')).toBe('10 MB');
    expect(formatBytes(1_073_741_824)).toBe('1 GB');
    expect(formatBytes(-1)).toBe('—');
  });
});
