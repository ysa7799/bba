import { ProviderError } from '@businessos/shared';
import { createHmac, timingSafeEqual } from 'node:crypto';

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function hmacHex(
  algorithm: 'sha256' | 'sha1',
  secret: string,
  data: Buffer | string,
): string {
  return createHmac(algorithm, secret).update(data).digest('hex');
}

export function hmacBase64(
  algorithm: 'sha256' | 'sha1',
  secret: string,
  data: Buffer | string,
): string {
  return createHmac(algorithm, secret).update(data).digest('base64');
}

/** A provider failure with the provider's own error code (safe to store; no payload data). */
export class MessagingProviderError extends ProviderError {
  readonly providerCode: string | null;

  constructor(
    provider: string,
    message: string,
    options: { retryable: boolean; providerCode?: string | null },
  ) {
    super(provider, message, { retryable: options.retryable });
    this.providerCode = options.providerCode ?? null;
  }
}

/**
 * Calls a provider HTTP API with a timeout. Network failures and timeouts throw a retryable
 * error; HTTP responses (including errors) are returned for the adapter to interpret.
 */
export async function providerFetch(
  provider: string,
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs = 15_000,
): Promise<{ status: number; ok: boolean; body: unknown }> {
  let response: Response;
  try {
    response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new MessagingProviderError(provider, `${provider} request failed`, { retryable: true });
  }
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? (JSON.parse(text) as unknown) : null;
  } catch {
    body = null;
  }
  return { status: response.status, ok: response.ok, body };
}

/** Retry on rate limiting and server errors; client errors are permanent. */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export function requireCredential(
  credentials: Record<string, string>,
  key: string,
  provider: string,
): string {
  const value = credentials[key];
  if (!value) {
    throw new MessagingProviderError(
      provider,
      `${provider} is CONFIGURATION_REQUIRED: missing ${key}`,
      {
        retryable: false,
        providerCode: 'configuration_required',
      },
    );
  }
  return value;
}
