/**
 * Per-form embedding policy. `src/proxy.ts` asks the API which sites may frame a form and turns
 * the answer into a CSP `frame-ancestors` directive. Origins are re-validated here (they end up
 * in a response header), and anything unexpected falls back to `'none'` — fail closed.
 */

export const EMBED_PATH = /^\/f\/([a-z0-9](?:[a-z0-9-]{1,62}[a-z0-9]))\/embed\/?$/;

const ORIGIN =
  /^(https:\/\/(\*\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+(:\d{1,5})?|http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?)$/;

/** The `frame-ancestors` source list for the API's answer. */
export function frameAncestors(origins: unknown): string {
  if (!Array.isArray(origins) || origins.length === 0 || origins.length > 10) return "'none'";
  const valid = origins.filter(
    (origin): origin is string => typeof origin === 'string' && ORIGIN.test(origin),
  );
  return valid.length === origins.length ? valid.join(' ') : "'none'";
}
