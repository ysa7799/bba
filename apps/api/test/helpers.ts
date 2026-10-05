import { createDatabase, type DatabaseHandle } from '@businessos/database';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import { buildApp } from '../src/app';
import { loadApiEnv, type ApiEnv } from '../src/env';
import { createRedis } from '../src/lib/redis';

export interface TestContext {
  app: FastifyInstance;
  env: ApiEnv;
  db: DatabaseHandle;
  redis: Redis;
  close: () => Promise<void>;
}

/**
 * Builds an API instance against the test database and Redis. Pass `configure` to register
 * extra routes before the app is readied (useful for testing cross-cutting behaviour).
 */
export async function createTestContext(options?: {
  env?: Partial<Record<string, string>>;
  configure?: (app: FastifyInstance) => void | Promise<void>;
}): Promise<TestContext> {
  const env = loadApiEnv({ ...process.env, ...options?.env });
  const db = createDatabase({ url: env.DATABASE_URL, maxConnections: 4 });
  const redis = createRedis(env.REDIS_URL, 'businessos-api-test');
  const app = await buildApp({ env, db, redis });
  if (options?.configure) {
    await options.configure(app);
  }
  await app.ready();
  return {
    app,
    env,
    db,
    redis,
    close: async () => {
      await app.close();
      await db.close();
      await redis.quit();
    },
  };
}
