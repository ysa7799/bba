import 'server-only';
import { apiInternalUrl, forwardedFor } from './upstream';

export { apiInternalUrl, forwardedFor };

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
  // File downloads carry their own locked-down policy (no scripts, sandboxed).
  'content-security-policy',
  'content-type',
  'retry-after',
  'x-content-type-options',
  'x-request-id',
] as const;

export const MAX_PROXY_BODY_BYTES = 2 * 1024 * 1024;
/** CSV import uploads (5 MB of CSV, JSON-encoded); the API enforces the real limit. */
export const MAX_IMPORT_PROXY_BODY_BYTES = 12 * 1024 * 1024;
const IMPORT_UPLOAD_PATH = /^app\/orgs\/[0-9a-f-]{36}\/crm\/imports$/;
/** File uploads (10 MB files sent as raw bytes); the API enforces the real limit. */
export const MAX_FILE_PROXY_BODY_BYTES = 10 * 1024 * 1024 + 64 * 1024;
const FILE_UPLOAD_PATH = /^app\/orgs\/[0-9a-f-]{36}\/files$/;

/** Request body limit for a proxied path (only uploads get larger ones). */
export function maxBodyBytesFor(method: string, path: readonly string[]): number {
  if (method !== 'POST') return MAX_PROXY_BODY_BYTES;
  const joined = path.join('/');
  if (IMPORT_UPLOAD_PATH.test(joined)) return MAX_IMPORT_PROXY_BODY_BYTES;
  if (FILE_UPLOAD_PATH.test(joined)) return MAX_FILE_PROXY_BODY_BYTES;
  return MAX_PROXY_BODY_BYTES;
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
