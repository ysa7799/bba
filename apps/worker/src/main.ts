import { loadWorkerEnv } from './env';
import { createLogger } from './logger';
import { createWorkerRedis } from './redis';
import { startWorkers } from './worker';

function main(): void {
  const env = loadWorkerEnv();
  const logger = createLogger(env);
  const redis = createWorkerRedis(env.REDIS_URL, 'businessos-worker');
  const runtime = startWorkers({ env, redis, logger });
  logger.info({ concurrency: env.WORKER_CONCURRENCY }, 'worker started');

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
      // Lets in-flight jobs finish; unfinished jobs are retried by another worker.
      await runtime.close();
      await redis.quit();
    } finally {
      clearTimeout(timer);
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main();
