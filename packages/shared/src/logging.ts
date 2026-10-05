/**
 * Paths redacted from structured logs (pino `redact` syntax). Keep this list conservative:
 * it is better to redact too much than to leak a credential.
 */
export const LOG_REDACT_PATHS: readonly string[] = [
  'password',
  'newPassword',
  'currentPassword',
  'token',
  'accessToken',
  'refreshToken',
  'apiKey',
  'secret',
  'clientSecret',
  'authorization',
  'cookie',
  '*.password',
  '*.newPassword',
  '*.currentPassword',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.apiKey',
  '*.secret',
  '*.clientSecret',
  '*.cardNumber',
  '*.cvv',
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
];

/** Fields that must never be serialized from objects passed to loggers or error reporters. */
const SENSITIVE_KEY_PATTERN =
  /pass(word)?|secret|token|api[-_]?key|authorization|cookie|cvv|card[-_]?number|private[-_]?key/i;

/** Deep-copies a plain value replacing sensitive keys with "[REDACTED]". */
export function redactSensitive(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[TRUNCATED]';
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item, depth + 1));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = SENSITIVE_KEY_PATTERN.test(key) ? '[REDACTED]' : redactSensitive(inner, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * Paths whose next segment is a secret: per-connection webhook tokens
 * (`/webhooks/communications/<provider>/<token>`), invitee manage links
 * (`/public/booking/manage/<token>`) and customer document links
 * (`/public/commerce/invoices/<token>`, `/public/commerce/quotes/<token>`).
 */
const SECRET_PATH_SEGMENT =
  /^(\/webhooks\/communications\/[^/?#]+\/|\/webhooks\/automation\/|\/public\/booking\/manage\/|\/public\/commerce\/(?:invoices|quotes)\/)[^/?#]+/;

/**
 * Request URL as it may appear in logs: secret path segments (webhook and manage-link tokens)
 * and the values of sensitive query parameters (e.g. `hub.verify_token`, `token`) are masked.
 */
export function redactUrlForLog(url: string): string {
  const queryStart = url.indexOf('?');
  const path = queryStart === -1 ? url : url.slice(0, queryStart);
  const maskedPath = path.replace(SECRET_PATH_SEGMENT, '$1[REDACTED]');
  if (queryStart === -1) return maskedPath;
  const query = url
    .slice(queryStart + 1)
    .split('&')
    .map((pair) => {
      const separator = pair.indexOf('=');
      const rawKey = separator === -1 ? pair : pair.slice(0, separator);
      let key = rawKey;
      try {
        key = decodeURIComponent(rawKey.replace(/\+/g, ' '));
      } catch {
        // Malformed escapes: judge the raw key.
      }
      return SENSITIVE_KEY_PATTERN.test(key) ? `${rawKey}=[REDACTED]` : pair;
    })
    .join('&');
  return `${maskedPath}?${query}`;
}
