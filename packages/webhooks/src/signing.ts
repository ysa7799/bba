import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Header carrying `t=<unix seconds>,v1=<hex HMAC-SHA256>[,v1=…]`. */
export const SIGNATURE_HEADER = 'businessos-signature';
/** Receivers should refuse signatures older (or newer) than this. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

/** A new signing secret (256 bits). Shown to the customer once; stored encrypted. */
export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString('base64url')}`;
}

/** HMAC-SHA256 over `<timestamp>.<body>` with the secret, hex encoded. */
export function computeSignature(secret: string, timestamp: number, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

/**
 * The signature header for a body. Every active secret signs (the previous one too, for a day
 * after a rotation), so a receiver holding either secret can verify.
 */
export function signatureHeader(
  secrets: readonly string[],
  body: string,
  now: Date = new Date(),
): string {
  const timestamp = Math.floor(now.getTime() / 1000);
  const signatures = secrets.map((secret) => `v1=${computeSignature(secret, timestamp, body)}`);
  return [`t=${timestamp}`, ...signatures].join(',');
}

/**
 * Verifies a delivery the way receivers should: the timestamp is recent (replay protection)
 * and one of the `v1` signatures matches the exact body received, compared in constant time.
 */
export function verifyWebhookSignature(input: {
  body: string;
  header: string | null | undefined;
  secret: string;
  toleranceSeconds?: number;
  now?: Date;
}): boolean {
  if (!input.header) return false;
  let timestamp: number | null = null;
  const candidates: string[] = [];
  for (const part of input.header.split(',')) {
    const [name, value] = part.trim().split('=', 2);
    if (name === 't' && value && /^\d{1,12}$/.test(value)) timestamp = Number(value);
    if (name === 'v1' && value && /^[0-9a-f]{64}$/.test(value)) candidates.push(value);
  }
  if (timestamp === null || candidates.length === 0) return false;
  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
  const tolerance = input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (Math.abs(nowSeconds - timestamp) > tolerance) return false;
  const expected = Buffer.from(computeSignature(input.secret, timestamp, input.body), 'hex');
  return candidates.some((candidate) => timingSafeEqual(Buffer.from(candidate, 'hex'), expected));
}
