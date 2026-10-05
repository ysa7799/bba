import { RateLimitedError } from '@businessos/shared';
import { createHash } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { Redis } from 'ioredis';

export interface RateLimitPolicy {
  limit: number;
  windowSeconds: number;
}

/** Named policies. Dimensions (IP, account, user, organization, API key) are chosen per call. */
export const DEFAULT_RATE_LIMITS = {
  registerIp: { limit: 10, windowSeconds: 3600 },
  loginIp: { limit: 30, windowSeconds: 300 },
  loginAccountFailures: { limit: 5, windowSeconds: 900 },
  passwordResetIp: { limit: 10, windowSeconds: 3600 },
  passwordResetAccount: { limit: 3, windowSeconds: 3600 },
  verifyEmailIp: { limit: 30, windowSeconds: 3600 },
  resendVerificationAccount: { limit: 3, windowSeconds: 3600 },
  invitationIp: { limit: 30, windowSeconds: 3600 },
  createOrganizationUser: { limit: 10, windowSeconds: 3600 },
  changePasswordUser: { limit: 10, windowSeconds: 3600 },
} satisfies Record<string, RateLimitPolicy>;

export type RateLimitName = keyof typeof DEFAULT_RATE_LIMITS;
export type RateLimitPolicies = Record<RateLimitName, RateLimitPolicy>;

// INCR + EXPIRE atomically; returns [count, ttl].
const HIT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('TTL', KEYS[1])
if ttl < 0 then redis.call('EXPIRE', KEYS[1], ARGV[1]); ttl = tonumber(ARGV[1]) end
return {count, ttl}
`;

/**
 * Fixed-window counters in Redis. Keys are hashed so personal data (emails) never appears in
 * Redis. When Redis is unavailable the limiter fails open and logs (availability choice,
 * documented in SECURITY.md); argon2 cost still throttles password guessing.
 */
export class RateLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly prefix: string,
    private readonly policies: RateLimitPolicies,
    private readonly log: FastifyBaseLogger,
  ) {}

  private key(name: RateLimitName, dimension: string): string {
    const digest = createHash('sha256').update(dimension).digest('base64url').slice(0, 32);
    return `${this.prefix}rl:${name}:${digest}`;
  }

  /** Counts a hit and throws RateLimitedError when the policy is exceeded. */
  async consume(name: RateLimitName, dimension: string): Promise<void> {
    const policy = this.policies[name];
    try {
      const [count, ttl] = (await this.redis.eval(
        HIT_SCRIPT,
        1,
        this.key(name, dimension),
        String(policy.windowSeconds),
      )) as [number, number];
      if (count > policy.limit) {
        throw new RateLimitedError(Math.max(1, ttl));
      }
    } catch (error) {
      if (error instanceof RateLimitedError) throw error;
      this.log.error({ err: error, limiter: name }, 'rate limiter unavailable; failing open');
    }
  }

  /** Throws if the counter is already at the limit, without counting a hit. */
  async assertBelow(name: RateLimitName, dimension: string): Promise<void> {
    const policy = this.policies[name];
    try {
      const key = this.key(name, dimension);
      const [count, ttl] = await Promise.all([this.redis.get(key), this.redis.ttl(key)]);
      if (Number(count ?? 0) >= policy.limit) {
        throw new RateLimitedError(Math.max(1, ttl));
      }
    } catch (error) {
      if (error instanceof RateLimitedError) throw error;
      this.log.error({ err: error, limiter: name }, 'rate limiter unavailable; failing open');
    }
  }

  async reset(name: RateLimitName, dimension: string): Promise<void> {
    try {
      await this.redis.del(this.key(name, dimension));
    } catch (error) {
      this.log.error({ err: error, limiter: name }, 'rate limiter reset failed');
    }
  }
}
