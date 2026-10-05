import { or, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { escapeLike } from './normalize';

const MAX_TERMS = 8;

/** Lower-cased search terms with only letters, digits and a few joiners (any script). */
export function searchTerms(raw: string): string[] {
  return raw
    .normalize('NFKC')
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.replace(/[^\p{L}\p{N}@._+-]/gu, '').slice(0, 64))
    .filter((term) => term.length > 0)
    .slice(0, MAX_TERMS);
}

/** Prefix tsquery (`'ahm':* & 'kha':*`) built only from sanitized, quoted terms. */
export function prefixTsQuery(terms: readonly string[]): string {
  return terms.map((term) => `'${term.replace(/'/g, "''")}':*`).join(' & ');
}

/**
 * PostgreSQL search over a generated `tsvector` (simple configuration, so Arabic and English
 * both work without stemming). Phone-looking input additionally matches digits anywhere in the
 * given phone columns. This is the seam a dedicated search engine can replace later.
 */
export function searchCondition(
  vector: AnyColumn,
  raw: string,
  phoneColumns: readonly AnyColumn[] = [],
): SQL | undefined {
  const terms = searchTerms(raw);
  const conditions: SQL[] = [];
  if (terms.length > 0) {
    conditions.push(sql`${vector} @@ to_tsquery('simple', ${prefixTsQuery(terms)})`);
  }
  const digits = raw.replace(/\D/g, '');
  if (phoneColumns.length > 0 && /^[\d\s+()./-]+$/.test(raw.trim()) && digits.length >= 4) {
    const pattern = `%${escapeLike(digits.slice(0, 15))}%`;
    for (const column of phoneColumns) conditions.push(sql`${column} LIKE ${pattern}`);
  }
  if (conditions.length === 0) return sql`false`;
  return or(...conditions);
}
