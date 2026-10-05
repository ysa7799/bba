import { createHash, randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';
import { z } from 'zod';

const claimsSchema = z.object({ formId: z.uuid(), versionId: z.uuid(), issuedAt: z.number() });
export type RenderClaims = z.infer<typeof claimsSchema>;

/** 256-bit, URL-safe: 43 characters. */
export const RENDER_TOKEN = /^[A-Za-z0-9_-]{43}$/;

/**
 * Render tokens prove a submission comes from a form the server actually rendered: they carry
 * the version shown and the time it was shown (minimum fill time), and their hash is the
 * submission's idempotency key (a double submit is stored once). Only the SHA-256 of the token
 * is used as the Redis key, so the token itself is not stored.
 */
export class RenderTokenStore {
  constructor(
    private readonly redis: Redis,
    private readonly prefix: string,
    private readonly ttlSeconds = 24 * 60 * 60,
  ) {}

  static digest(token: string): string {
    return createHash('sha256').update(token).digest('base64url');
  }

  private key(token: string): string {
    return `${this.prefix}forms:render:${RenderTokenStore.digest(token)}`;
  }

  async issue(formId: string, versionId: string, now = Date.now()): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    const claims: RenderClaims = { formId, versionId, issuedAt: now };
    await this.redis.set(this.key(token), JSON.stringify(claims), 'EX', this.ttlSeconds);
    return token;
  }

  async read(token: string): Promise<RenderClaims | null> {
    if (!RENDER_TOKEN.test(token)) return null;
    const raw = await this.redis.get(this.key(token));
    if (!raw) return null;
    try {
      const parsed = claimsSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }
}
