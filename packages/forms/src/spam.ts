import { ProviderError } from '@businessos/shared';
import type { FormField } from '@businessos/database';

/**
 * Spam defences for public forms. Layered: per-IP and per-form rate limits (API), a server-issued
 * render token (proves the form was loaded, sets a minimum fill time, deduplicates double
 * submits), a honeypot field, content heuristics and an optional captcha. Submissions flagged
 * as spam are stored for review but never touch the CRM, and the submitter sees the normal
 * confirmation so bots learn nothing.
 */
export const SPAM_REASONS = ['honeypot', 'too_fast', 'excessive_links'] as const;
export type SpamReason = (typeof SPAM_REASONS)[number];

/** Humans need a few seconds to fill even a one-field form. */
export const MIN_FILL_MS = 3_000;
const MAX_LINKS = 3;
const LINK = /(?:https?:\/\/|www\.|\[url[=\]])/gi;

export interface SubmissionSignals {
  /** Value of the hidden honeypot input (empty for people). */
  honeypot?: string | undefined;
  /** Time between rendering the form and submitting it. */
  elapsedMs: number;
}

/** Reasons a validated submission looks automated (empty when it looks genuine). */
export function spamReasons(
  signals: SubmissionSignals,
  fields: readonly FormField[],
  answers: Record<string, unknown>,
): SpamReason[] {
  const reasons: SpamReason[] = [];
  if (signals.honeypot !== undefined && signals.honeypot.trim() !== '') reasons.push('honeypot');
  if (signals.elapsedMs < MIN_FILL_MS) reasons.push('too_fast');
  let links = 0;
  for (const field of fields) {
    if (field.type !== 'text' && field.type !== 'textarea') continue;
    const value = answers[field.key];
    if (typeof value === 'string') links += value.match(LINK)?.length ?? 0;
  }
  if (links > MAX_LINKS) reasons.push('excessive_links');
  return reasons;
}

/** Captcha verification port. Without credentials the provider is CONFIGURATION_REQUIRED. */
export interface CaptchaVerifier {
  readonly provider: 'turnstile' | 'fake';
  /** Public key the browser widget needs (never a secret). */
  readonly siteKey: string;
  /** True when the token is valid. Throws ProviderError when the provider cannot be reached. */
  verify(token: string, remoteIp: string): Promise<boolean>;
}

const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** Cloudflare Turnstile (server-side token verification). */
export class TurnstileVerifier implements CaptchaVerifier {
  readonly provider = 'turnstile' as const;

  constructor(
    readonly siteKey: string,
    private readonly secretKey: string,
    private readonly options: { fetch?: typeof fetch; timeoutMs?: number } = {},
  ) {}

  async verify(token: string, remoteIp: string): Promise<boolean> {
    if (token.length === 0 || token.length > 2_048) return false;
    const body = new URLSearchParams({
      secret: this.secretKey,
      response: token,
      remoteip: remoteIp,
    });
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(TURNSTILE_VERIFY_URL, {
        method: 'POST',
        body,
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 5_000),
      });
    } catch (error) {
      throw new ProviderError('turnstile', 'Captcha verification is unavailable', { cause: error });
    }
    if (!response.ok) {
      throw new ProviderError('turnstile', `Captcha verification failed (${response.status})`);
    }
    const result = (await response.json()) as { success?: unknown };
    return result.success === true;
  }
}

/** Development and test double: accepts the token `pass`. Refused in production by env. */
export class FakeCaptchaVerifier implements CaptchaVerifier {
  readonly provider = 'fake' as const;
  readonly siteKey = 'fake-site-key';

  verify(token: string): Promise<boolean> {
    return Promise.resolve(token === 'pass');
  }
}

export interface CaptchaEnv {
  TURNSTILE_SITE_KEY?: string | undefined;
  TURNSTILE_SECRET_KEY?: string | undefined;
  FORMS_FAKE_CAPTCHA?: boolean | undefined;
}

/** The configured verifier, or null (captcha cannot be required until one is configured). */
export function captchaFromEnv(env: CaptchaEnv): CaptchaVerifier | null {
  if (env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY) {
    return new TurnstileVerifier(env.TURNSTILE_SITE_KEY, env.TURNSTILE_SECRET_KEY);
  }
  return env.FORMS_FAKE_CAPTCHA ? new FakeCaptchaVerifier() : null;
}
