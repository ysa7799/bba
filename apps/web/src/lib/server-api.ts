import 'server-only';
import { headers } from 'next/headers';
import { apiInternalUrl, forwardedFor } from './api-proxy';
import type { Me } from './api-types';

/** Server-side fetch to the API's internal URL (never exposed to the browser bundle). */
export async function serverApiFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${apiInternalUrl()}${path}`, { ...init, cache: 'no-store' });
}

/**
 * Fetches from the API on behalf of the current visitor by forwarding their cookie header.
 * Used by server components to render authenticated pages.
 */
export async function serverApiAsUser(path: string): Promise<Response> {
  const incoming = await headers();
  const cookie = incoming.get('cookie');
  const requestId = incoming.get('x-request-id');
  const xff = forwardedFor(incoming);
  return serverApiFetch(path, {
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(requestId ? { 'x-request-id': requestId } : {}),
      // Attribute rate limits to the visitor, not to the web server.
      ...(xff ? { 'x-forwarded-for': xff } : {}),
    },
    signal: AbortSignal.timeout(10_000),
  });
}

/** The signed-in user, or null when there is no valid session. Throws on API failure. */
export async function getMe(): Promise<Me | null> {
  const response = await serverApiAsUser('/app/me');
  if (response.status === 401) return null;
  if (!response.ok) throw new Error(`Failed to load session (${response.status})`);
  return (await response.json()) as Me;
}

/**
 * GET helper for server components on tenant pages. Returns null for 401/404 (caller renders
 * not-found); throws for other failures so the route error boundary shows.
 */
export async function serverGetJson<T>(path: string): Promise<T | null> {
  const response = await serverApiAsUser(path);
  if (response.status === 401 || response.status === 404) return null;
  if (!response.ok) throw new Error(`Request failed (${response.status})`);
  return (await response.json()) as T;
}
