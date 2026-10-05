import { defaultAuthConfig, MemoryMailer } from '@businessos/auth';
import { MemoryJobQueue } from '@businessos/jobs';
import type { PaymentProviderRegistry } from '@businessos/payments';
import { createDatabase, type DatabaseHandle } from '@businessos/database';
import { uniqueSuffix } from '@businessos/testing';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { Redis } from 'ioredis';
import { buildApp } from '../src/app';
import { loadApiEnv, type ApiEnv } from '../src/env';
import type { RateLimitPolicies } from '../src/lib/rate-limiter';
import { createRedis } from '../src/lib/redis';

export const TEST_ORIGIN = 'http://localhost:3000';

export interface TestContext {
  app: FastifyInstance;
  env: ApiEnv;
  db: DatabaseHandle;
  redis: Redis;
  mailer: MemoryMailer;
  jobs: MemoryJobQueue;
  close: () => Promise<void>;
}

const RELAXED_LIMITS: Partial<RateLimitPolicies> = Object.fromEntries(
  [
    'registerIp',
    'loginIp',
    'passwordResetIp',
    'verifyEmailIp',
    'invitationIp',
    'createOrganizationUser',
    'passwordResetAccount',
    'resendVerificationAccount',
    'changePasswordUser',
    'checkoutOrg',
    'checkoutVerifyOrg',
  ].map((name) => [name, { limit: 10_000, windowSeconds: 60 }]),
);

/**
 * Builds an API instance against the test database and Redis with an isolated Redis key
 * prefix. Rate limits are relaxed unless `strictRateLimits` is set.
 */
export async function createTestContext(options?: {
  env?: Partial<Record<string, string>>;
  strictRateLimits?: boolean;
  /** Use the production queue-backed mailer instead of the in-memory mailer. */
  queueMailer?: boolean;
  /** Controllable payment providers (e.g. a FakePaymentProvider). */
  paymentProviders?: PaymentProviderRegistry;
  configure?: (app: FastifyInstance) => void | Promise<void>;
}): Promise<TestContext> {
  const env = loadApiEnv({
    ...process.env,
    REDIS_KEY_PREFIX: `test:${uniqueSuffix()}:`,
    PASSWORD_HASH_MEMORY_KIB: '1024',
    PASSWORD_HASH_TIME_COST: '1',
    ...options?.env,
  });
  const db = createDatabase({ url: env.DATABASE_URL, maxConnections: 4 });
  const redis = createRedis(env.REDIS_URL, 'businessos-api-test');
  const mailer = new MemoryMailer();
  const jobs = new MemoryJobQueue();
  const authConfig = {
    ...defaultAuthConfig(env.APP_URL),
    password: {
      memoryCostKib: env.PASSWORD_HASH_MEMORY_KIB,
      timeCost: env.PASSWORD_HASH_TIME_COST,
      parallelism: 1,
    },
  };
  const app = await buildApp({
    env,
    db,
    redis,
    ...(options?.queueMailer ? {} : { mailer }),
    jobs,
    authConfig,
    ...(options?.paymentProviders ? { paymentProviders: options.paymentProviders } : {}),
    ...(options?.strictRateLimits ? {} : { rateLimits: RELAXED_LIMITS }),
  });
  if (options?.configure) {
    await options.configure(app);
  }
  await app.ready();
  return {
    app,
    env,
    db,
    redis,
    mailer,
    jobs,
    close: async () => {
      await app.close();
      await db.close();
      await redis.quit();
    },
  };
}

/** Minimal cookie-jar client for `app.inject`, sending the allowed Origin on writes. */
export class TestClient {
  private cookies = new Map<string, string>();

  constructor(private readonly app: FastifyInstance) {}

  async request(
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    url: string,
    payload?: unknown,
    headers: Record<string, string> = {},
  ): Promise<LightMyRequestResponse> {
    const cookieHeader = [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    const response = await this.app.inject({
      method,
      url,
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
      headers: {
        ...(method === 'GET' ? {} : { origin: TEST_ORIGIN }),
        ...(cookieHeader ? { cookie: cookieHeader } : {}),
        ...headers,
      },
    });
    for (const cookie of response.cookies) {
      if (cookie.value === '' || (cookie.expires && cookie.expires.getTime() <= Date.now())) {
        this.cookies.delete(cookie.name);
      } else {
        this.cookies.set(cookie.name, cookie.value);
      }
    }
    return response;
  }

  get(url: string, headers?: Record<string, string>) {
    return this.request('GET', url, undefined, headers);
  }

  post(url: string, payload?: unknown, headers?: Record<string, string>) {
    return this.request('POST', url, payload ?? {}, headers);
  }

  patch(url: string, payload?: unknown) {
    return this.request('PATCH', url, payload ?? {});
  }

  delete(url: string) {
    return this.request('DELETE', url);
  }

  sessionCookie(): string | undefined {
    return this.cookies.get('bos_session');
  }

  setCookie(name: string, value: string): void {
    this.cookies.set(name, value);
  }
}

export const TEST_PASSWORD = 'correct horse battery staple';

/** Sets a known password for a fixture user and signs in through the HTTP API. */
export async function loginAs(
  ctx: TestContext,
  user: { id: string; email: string },
): Promise<TestClient> {
  const { hashPassword } = await import('@businessos/auth');
  const { users, withSystem } = await import('@businessos/database');
  const { eq } = await import('drizzle-orm');
  const passwordHash = await hashPassword(TEST_PASSWORD, {
    memoryCostKib: ctx.env.PASSWORD_HASH_MEMORY_KIB,
    timeCost: ctx.env.PASSWORD_HASH_TIME_COST,
    parallelism: 1,
  });
  await withSystem(ctx.db.db, (tx) =>
    tx.update(users).set({ passwordHash }).where(eq(users.id, user.id)),
  );
  const client = new TestClient(ctx.app);
  const response = await client.post('/app/auth/login', {
    email: user.email,
    password: TEST_PASSWORD,
  });
  if (response.statusCode !== 200) {
    throw new Error(`login failed for ${user.email}: ${response.statusCode} ${response.body}`);
  }
  return client;
}
