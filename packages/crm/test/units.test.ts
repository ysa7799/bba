import { ValidationError } from '@businessos/shared';
import { describe, expect, it } from 'vitest';
import {
  escapeFormula,
  normalizeDomain,
  normalizeEmail,
  normalizePhone,
  normalizeUrl,
  parseCsv,
  prefixTsQuery,
  searchTerms,
  suggestMapping,
  toCsv,
  unescapeFormula,
} from '../src';

describe('CSV parsing', () => {
  it('handles quotes, escaped quotes, CRLF, BOM and blank lines', () => {
    const rows = parseCsv(
      '﻿name,notes\r\n"Al Noor, W.L.L.","He said ""hi""\nnext line"\r\n\r\nplain,5" screen\n',
    );
    expect(rows).toEqual([
      ['name', 'notes'],
      ['Al Noor, W.L.L.', 'He said "hi"\nnext line'],
      ['plain', '5" screen'],
    ]);
  });

  it('detects semicolon and tab delimiters', () => {
    expect(parseCsv('a;b\n1;2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
    expect(parseCsv('a\tb\n1\t2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('keeps Arabic text intact', () => {
    expect(parseCsv('الاسم,المدينة\nمحمد,المنامة')).toEqual([
      ['الاسم', 'المدينة'],
      ['محمد', 'المنامة'],
    ]);
  });

  it('rejects unterminated quotes and oversized input', () => {
    expect(() => parseCsv('a,"b\n1,2')).toThrow(ValidationError);
    expect(() => parseCsv('a\n1\n2\n3', { maxRows: 2, maxColumns: 5, maxFieldLength: 10 })).toThrow(
      /data rows/,
    );
    expect(() => parseCsv('a,b,c', { maxRows: 5, maxColumns: 2, maxFieldLength: 10 })).toThrow(
      /columns/,
    );
    expect(() =>
      parseCsv(`a\n${'x'.repeat(20)}`, { maxRows: 5, maxColumns: 2, maxFieldLength: 10 }),
    ).toThrow(/longer/);
  });
});

describe('CSV writing', () => {
  it('neutralizes spreadsheet formulas and round-trips through import', () => {
    for (const dangerous of ['=HYPERLINK("http://x")', '+973', '-2+3', '@SUM(A1)', '\tcmd']) {
      expect(escapeFormula(dangerous).startsWith("'")).toBe(true);
      expect(unescapeFormula(escapeFormula(dangerous))).toBe(dangerous);
    }
    expect(escapeFormula('Manama')).toBe('Manama');
    expect(unescapeFormula("'quoted")).toBe("'quoted");
  });

  it('quotes delimiters and writes a BOM for Excel', () => {
    const csv = toCsv(
      ['name', 'note'],
      [
        ['A, B', 'say "x"'],
        ['=1+1', null],
      ],
    );
    expect(csv).toBe('﻿name,note\r\n"A, B","say ""x"""\r\n\'=1+1,\r\n');
    expect(parseCsv(csv)).toEqual([
      ['name', 'note'],
      ['A, B', 'say "x"'],
      ["'=1+1", ''],
    ]);
  });
});

describe('normalization', () => {
  it('reads national phone numbers in the organization country', () => {
    expect(normalizePhone('3312 3456', 'BH')).toBe('+97333123456');
    expect(normalizePhone('0097333123456', 'SA')).toBe('+97333123456');
    expect(normalizePhone('+966 50 123 4567', 'BH')).toBe('+966501234567');
    expect(() => normalizePhone('12', 'BH')).toThrow(ValidationError);
    expect(() => normalizePhone('not a phone', 'BH')).toThrow(ValidationError);
  });

  it('normalizes emails, domains and URLs', () => {
    expect(normalizeEmail('  Sara@Example.COM ')).toBe('sara@example.com');
    expect(() => normalizeEmail('nope')).toThrow(ValidationError);
    expect(normalizeDomain('https://www.Gulf-Trading.com.bh/about')).toBe('gulf-trading.com.bh');
    expect(normalizeDomain('example.com')).toBe('example.com');
    expect(() => normalizeDomain('localhost')).toThrow(ValidationError);
    expect(() => normalizeDomain('javascript:alert(1)')).toThrow(ValidationError);
    expect(normalizeUrl('example.com/path')).toBe('https://example.com/path');
    expect(() => normalizeUrl('javascript:alert(1)')).toThrow(ValidationError);
  });
});

describe('search terms', () => {
  it('builds prefix queries only from sanitized terms', () => {
    expect(searchTerms("Ahmed  O'Neil & | !(x):*")).toEqual(['ahmed', 'oneil', 'x']);
    expect(prefixTsQuery(searchTerms('محمد الخليفة'))).toBe("'محمد':* & 'الخليفة':*");
    expect(searchTerms('')).toEqual([]);
  });
});

describe('import mapping suggestions', () => {
  it('matches common header names and custom fields', () => {
    const mapping = suggestMapping(
      ['First Name', 'Surname', 'E-mail', 'Mobile', 'Company', 'Membership tier', 'Unknown'],
      'contact',
      [{ key: 'cf:tier', label: 'Membership tier' }],
    );
    expect(mapping).toEqual({
      '0': 'first_name',
      '1': 'last_name',
      '2': 'email',
      '3': 'phone',
      '4': 'company_name',
      '5': 'cf:tier',
    });
  });

  it('drops "name" as full name when first/last are present', () => {
    expect(suggestMapping(['Name', 'First name'], 'contact', [])).toEqual({ '1': 'first_name' });
  });
});
