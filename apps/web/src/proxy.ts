import { NextResponse, type NextRequest } from 'next/server';
import { EMBED_PATH, frameAncestors } from './lib/embed-policy';
import { apiInternalUrl, forwardedFor } from './lib/upstream';

/**
 * Embedded forms may only be framed by the sites their form allows. Everything else keeps the
 * global `X-Frame-Options: DENY` from next.config.ts (which skips the embed route).
 */
export async function proxy(request: NextRequest): Promise<NextResponse> {
  const slug = EMBED_PATH.exec(request.nextUrl.pathname)?.[1];
  let ancestors = "'none'";
  if (slug) {
    try {
      const xff = forwardedFor(request.headers);
      const upstream = await fetch(`${apiInternalUrl()}/public/forms/${slug}/embed-policy`, {
        headers: xff ? { 'x-forwarded-for': xff } : {},
        cache: 'no-store',
        signal: AbortSignal.timeout(5_000),
      });
      if (upstream.ok) {
        const body = (await upstream.json()) as { frameAncestors?: unknown };
        ancestors = frameAncestors(body.frameAncestors);
      }
    } catch {
      // Fail closed: the form simply cannot be framed while the API is unreachable.
    }
  }
  const response = NextResponse.next();
  response.headers.set('Content-Security-Policy', `frame-ancestors ${ancestors}`);
  return response;
}

export const config = { matcher: '/f/:slug/embed' };
