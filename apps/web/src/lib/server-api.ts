import 'server-only';

const apiInternalUrl = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';

/** Server-side fetch to the API's internal URL (never exposed to the browser bundle). */
export async function serverApiFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${apiInternalUrl}${path}`, { ...init, cache: 'no-store' });
}
