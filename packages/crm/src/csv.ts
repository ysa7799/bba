import { ValidationError } from '@businessos/shared';

export interface CsvLimits {
  maxRows: number;
  maxColumns: number;
  maxFieldLength: number;
}

export const DEFAULT_CSV_LIMITS: CsvLimits = {
  maxRows: 10_001,
  maxColumns: 60,
  maxFieldLength: 10_000,
};

function detectDelimiter(text: string): ',' | ';' | '\t' {
  const firstLine = text.slice(0, 4096).split(/\r\n|\n|\r/)[0] ?? '';
  let inQuotes = false;
  const counts = { ',': 0, ';': 0, '\t': 0 };
  for (const char of firstLine) {
    if (char === '"') inQuotes = !inQuotes;
    else if (!inQuotes && (char === ',' || char === ';' || char === '\t')) counts[char] += 1;
  }
  if (counts[';'] > counts[','] && counts[';'] >= counts['\t']) return ';';
  if (counts['\t'] > counts[','] && counts['\t'] > counts[';']) return '\t';
  return ',';
}

/**
 * RFC 4180 CSV parser (quoted fields, doubled quotes, CRLF/LF/CR line endings, UTF-8 BOM) with
 * delimiter detection for comma, semicolon (Excel in many locales) and tab. Blank lines are
 * skipped; a quote inside an unquoted value is kept literally (e.g. 5" screen). Throws a
 * validation error for unterminated quotes and size-limit violations.
 */
export function parseCsv(input: string, limits: CsvLimits = DEFAULT_CSV_LIMITS): string[][] {
  const text = input.startsWith('\uFEFF') ? input.slice(1) : input;
  const delimiter = detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let fieldStarted = false;

  const fail = (message: string): never => {
    throw new ValidationError(`Invalid CSV file: ${message}`, [{ path: 'file', message }]);
  };
  const pushField = () => {
    if (field.length > limits.maxFieldLength) {
      fail(`A value on row ${rows.length + 1} is longer than ${limits.maxFieldLength} characters`);
    }
    row.push(field);
    if (row.length > limits.maxColumns) fail(`More than ${limits.maxColumns} columns`);
    field = '';
    fieldStarted = false;
  };
  const pushRow = () => {
    pushField();
    if (!(row.length === 1 && row[0] === '')) {
      rows.push(row);
      if (rows.length > limits.maxRows) fail(`More than ${limits.maxRows - 1} data rows`);
    }
    row = [];
  };

  for (let i = 0; i < text.length; i += 1) {
    const char = text.charAt(i);
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"' && !fieldStarted) {
      inQuotes = true;
      fieldStarted = true;
    } else if (char === delimiter) {
      pushField();
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      pushRow();
    } else {
      field += char;
      fieldStarted = true;
    }
  }
  if (inQuotes) fail('Unterminated quoted value');
  if (field !== '' || row.length > 0) pushRow();
  return rows;
}

const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

/**
 * Neutralizes spreadsheet formula injection: values starting with = + - @ tab or CR are
 * prefixed with an apostrophe so spreadsheet apps treat them as text.
 */
export function escapeFormula(value: string): string {
  return FORMULA_TRIGGER.test(value) ? `'${value}` : value;
}

/** Reverses `escapeFormula` for values coming back in through import. */
export function unescapeFormula(value: string): string {
  return value.startsWith("'") && FORMULA_TRIGGER.test(value.slice(1)) ? value.slice(1) : value;
}

function quote(value: string): string {
  return /[",\r\n;]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function toCsvRow(
  values: readonly (string | number | boolean | null | undefined)[],
): string {
  return values
    .map((value) =>
      value === null || value === undefined ? '' : quote(escapeFormula(String(value))),
    )
    .join(',');
}

/** CSV document with a UTF-8 BOM so Excel opens Arabic text correctly. */
export function toCsv(
  header: readonly string[],
  rows: Iterable<readonly (string | number | boolean | null | undefined)[]>,
): string {
  const lines = [toCsvRow(header)];
  for (const row of rows) lines.push(toCsvRow(row));
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}
