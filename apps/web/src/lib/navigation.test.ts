import { describe, expect, it } from 'vitest';
import { safeNextPath } from './navigation';

describe('safeNextPath', () => {
  it('accepts same-site relative paths', () => {
    expect(safeNextPath('/o/123/members?x=1')).toBe('/o/123/members?x=1');
    expect(safeNextPath('/invite?token=abc')).toBe('/invite?token=abc');
  });

  it.each([
    '//evil.example.com',
    '/\\evil.example.com',
    'https://evil.example.com',
    'javascript:alert(1)',
    '/\tevil',
    'evil',
    '',
  ])('rejects %j', (value) => {
    expect(safeNextPath(value)).toBeNull();
  });

  it('rejects non-string values', () => {
    expect(safeNextPath(undefined)).toBeNull();
    expect(safeNextPath(['/a', '/b'])).toBeNull();
  });
});
