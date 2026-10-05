import { CalendarProviderError } from './types';

export interface HttpOptions {
  fetch?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
}

/**
 * JSON request to a calendar API with a bearer token. Network failures, timeouts, 429 and 5xx
 * are retryable; 401/403 mean the connection must be re-authorized; other 4xx are permanent.
 * Response bodies are never included in error messages (they can echo request data).
 */
export async function providerRequest(
  provider: string,
  options: HttpOptions,
  url: string,
  init: { method: string; token: string; body?: unknown; allowStatuses?: number[] },
): Promise<{ status: number; body: unknown }> {
  const fetchImpl = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: init.method,
      headers: {
        authorization: `Bearer ${init.token}`,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
  } catch {
    throw new CalendarProviderError(provider, `${provider} request failed`, { retryable: true });
  }
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? (JSON.parse(text) as unknown) : null;
  } catch {
    body = null;
  }
  if (response.ok || init.allowStatuses?.includes(response.status)) {
    return { status: response.status, body };
  }
  if (response.status === 401 || response.status === 403) {
    throw new CalendarProviderError(provider, `${provider} rejected the credentials`, {
      retryable: false,
      providerCode: 'unauthorized',
    });
  }
  throw new CalendarProviderError(provider, `${provider} returned HTTP ${response.status}`, {
    retryable: response.status === 429 || response.status >= 500,
    providerCode: String(response.status),
  });
}

export function requireToken(provider: string, credentials: Record<string, string>): string {
  const token = credentials.accessToken;
  if (!token) {
    throw new CalendarProviderError(provider, `${provider} is CONFIGURATION_REQUIRED`, {
      retryable: false,
      providerCode: 'configuration_required',
    });
  }
  return token;
}
