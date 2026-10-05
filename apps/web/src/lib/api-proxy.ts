import 'server-only';

/** Request headers forwarded from the browser to the API. Everything else is dropped. */
const FORWARDED_REQUEST_HEADERS = [
  'accept',
  'accept-language',
  'content-type',
  'cookie',
  'origin',
  'referer',
  'user-agent',
  'x-request-id',
] as const;

/** Response headers passed back to the browser. */
const FORWARDED_RESPONSE_HEADERS = [
  'cache-control',
  'content-disposition',
  'content-type',
  'retry-after',
  'x-request-id',
] as const;

export const MAX_PROXY_BODY_BYTES = 2 * 1024 * 1024;

export function apiInternalUrl(): string {
  return process.env.API_INTERNAL_URL ?? 'http://localhost:4000';
}

/**
 * Client IP chain to hand to the API. Only forwarded when `TRUST_PROXY_HEADERS=true`, i.e. the
 * web server sits behind a load balancer/CDN that overwrites `x-forwarded-for`; otherwise a
 * client could spoof its IP and dodge per-IP rate limits.
 */
export function forwardedFor(incoming: Headers): string | null {
  if (process.env.TRUST_PROXY_HEADERS !== 'true') return null;
  const value = incoming.get('x-forwarded-for') ?? incoming.get('x-real-ip');
  if (!value) return null;
  const cleaned = value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => /^[0-9a-fA-F:.]{2,45}$/.test(part));
  return cleaned.length > 0 ? cleaned.join(', ') : null;
}

export function buildForwardHeaders(incoming: Headers): Headers {
  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = incoming.get(name);
    if (value !== null) headers.set(name, value);
  }
  const xff = forwardedFor(incoming);
  if (xff) headers.set('x-forwarded-for', xff);
  return headers;
}

export function buildResponseHeaders(upstream: Response): Headers {
  const headers = new Headers();
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  for (const cookie of upstream.headers.getSetCookie()) {
    headers.append('set-cookie', cookie);
  }
  return headers;
}
