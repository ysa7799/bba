import type { NextRequest } from 'next/server';
import {
  apiInternalUrl,
  buildForwardHeaders,
  buildResponseHeaders,
  MAX_PROXY_BODY_BYTES,
} from '@/lib/api-proxy';

export const dynamic = 'force-dynamic';

function errorResponse(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message, requestId: '' } }, { status });
}

/**
 * Same-origin proxy to the API (ADR-009). Resolved at runtime so `API_INTERNAL_URL` can differ
 * per environment, and so the session cookie stays first-party. Only an allow-list of headers
 * crosses in either direction.
 */
async function proxy(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const { path } = await context.params;
  const target = new URL(`${apiInternalUrl()}/${path.map(encodeURIComponent).join('/')}`);
  target.search = request.nextUrl.search;

  let body: ArrayBuffer | undefined;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const declared = Number(request.headers.get('content-length') ?? '0');
    if (declared > MAX_PROXY_BODY_BYTES) {
      return errorResponse(413, 'payload_too_large', 'Request body is too large');
    }
    body = await request.arrayBuffer();
    if (body.byteLength > MAX_PROXY_BODY_BYTES) {
      return errorResponse(413, 'payload_too_large', 'Request body is too large');
    }
  }

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers: buildForwardHeaders(request.headers),
      ...(body === undefined ? {} : { body }),
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    return errorResponse(502, 'provider_error', 'The service is temporarily unavailable');
  }
  return new Response(upstream.status === 204 ? null : upstream.body, {
    status: upstream.status,
    headers: buildResponseHeaders(upstream),
  });
}

export { proxy as GET, proxy as POST, proxy as PATCH, proxy as PUT, proxy as DELETE };
