/**
 * Where the API lives and which client IP chain to forward to it. Free of `server-only` so the
 * request proxy (`src/proxy.ts`) can use it too.
 */

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
