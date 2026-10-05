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
