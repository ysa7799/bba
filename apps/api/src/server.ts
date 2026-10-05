import { defaultAuthConfig } from '@businessos/auth';
import { createDatabase } from '@businessos/database';
import { buildApp } from './app';
import { loadApiEnv } from './env';
import { createRedis } from './lib/redis';

async function main(): Promise<void> {
  const env = loadApiEnv();
  const db = createDatabase({
    url: env.DATABASE_URL,
    maxConnections: env.DB_POOL_MAX,
    applicationName: 'businessos-api',
  });
  const redis = createRedis(env.REDIS_URL, 'businessos-api');
  const authConfig = {
    ...defaultAuthConfig(env.APP_URL),
    password: {
      memoryCostKib: env.PASSWORD_HASH_MEMORY_KIB,
      timeCost: env.PASSWORD_HASH_TIME_COST,
      parallelism: 1,
    },
  };

  const app = await buildApp({ env, db, redis, authConfig });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down');
    const timer = setTimeout(() => {
      app.log.error('forced shutdown after timeout');
      process.exit(1);
    }, 15_000);
    try {
      await app.close();
      await Promise.allSettled([db.close(), redis.quit()]);
    } finally {
      clearTimeout(timer);
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ host: env.API_HOST, port: env.API_PORT });
}

main().catch((error: unknown) => {
  process.stderr.write(
    `API failed to start: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
