import { createDatabase } from '@businessos/database';
import { BullJobQueue } from '@businessos/jobs';
import { createEmailTransport } from './email/transports';
import { loadWorkerEnv } from './env';
import { buildHandlers } from './handlers';
import { startHealthServer } from './health';
import { createLogger } from './logger';
import { createWorkerRedis } from './redis';
import { startRuntime } from './runtime';
import { createSubscriberRegistry } from './subscribers';

function main(): void {
  const env = loadWorkerEnv();
  const logger = createLogger(env);
  const db = createDatabase({
    url: env.DATABASE_URL,
    maxConnections: env.DB_POOL_MAX,
    applicationName: 'businessos-worker',
  });
  const redis = createWorkerRedis(env.REDIS_URL, 'businessos-worker');
  const queueRedis = createWorkerRedis(env.REDIS_URL, 'businessos-worker-producer');
  const queue = new BullJobQueue(queueRedis, env.QUEUE_PREFIX);
  const registry = createSubscriberRegistry();
  const runtime = startRuntime({
    db: db.db,
    redis,
    queue,
    registry,
    handlers: buildHandlers({
      db: db.db,
      registry,
      email: createEmailTransport(env, logger),
      logger,
    }),
    logger,
    prefix: env.QUEUE_PREFIX,
    concurrency: env.WORKER_CONCURRENCY,
    outboxPollMs: env.OUTBOX_POLL_MS,
  });
  // Hourly subscription upkeep (past_due, paused, cancel at period end, expired checkouts).
  queue
    .schedule('billing-maintenance', 'billing.maintenance', {}, 3_600_000)
    .catch((error: unknown) => {
      logger.error({ err: error }, 'could not schedule billing maintenance');
    });
  const health =
    env.WORKER_HEALTH_PORT > 0 ? startHealthServer(env.WORKER_HEALTH_PORT, db, redis) : null;
  logger.info(
    { concurrency: env.WORKER_CONCURRENCY, emailTransport: env.EMAIL_TRANSPORT },
    'worker started',
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'worker shutting down');
    const timer = setTimeout(() => {
      logger.error('forced worker shutdown after timeout');
      process.exit(1);
    }, 30_000);
    try {
      // In-flight jobs finish; unfinished jobs are retried by another worker.
      await runtime.close();
      await queue.close();
      health?.close();
      await Promise.allSettled([db.close(), redis.quit(), queueRedis.quit()]);
    } finally {
      clearTimeout(timer);
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main();
