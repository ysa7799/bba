import type { AutomationServices } from '@businessos/automation';
import { createCalendarProviders } from '@businessos/calendar';
import { createChannelProviders } from '@businessos/communications';
import { createDatabase } from '@businessos/database';
import { SecretBox } from '@businessos/shared';
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
  const automation: AutomationServices = {
    allowPrivateNetwork: env.AUTOMATION_ALLOW_PRIVATE_NETWORK,
    ownHosts: [new URL(env.API_PUBLIC_URL).hostname, new URL(env.APP_URL).hostname],
    enqueue: (name, payload, options) =>
      queue.enqueue(name, payload as never, {
        organizationId: options.organizationId,
        ...(options.jobId ? { jobId: options.jobId } : {}),
        ...(options.delayMs ? { delayMs: options.delayMs } : {}),
        ...(options.correlationId ? { correlationId: options.correlationId } : {}),
      }),
  };
  const registry = createSubscriberRegistry(db.db, automation);
  const secretBox = env.CREDENTIALS_ENCRYPTION_KEYS
    ? SecretBox.fromConfig(env.CREDENTIALS_ENCRYPTION_KEYS)
    : null;
  const runtime = startRuntime({
    db: db.db,
    redis,
    queue,
    registry,
    handlers: buildHandlers({
      db: db.db,
      communications: {
        providers: createChannelProviders({ fake: env.COMMUNICATIONS_FAKE_PROVIDERS }),
        secretBox,
        publicApiUrl: env.API_PUBLIC_URL,
      },
      calendar: {
        providers: createCalendarProviders({ fake: env.CALENDAR_FAKE_PROVIDERS }),
        secretBox,
      },
      automation,
      appUrl: env.APP_URL,
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
  // Hourly CRM upkeep (expired export files, stuck exports, old import staging rows).
  queue.schedule('crm-maintenance', 'crm.maintenance', {}, 3_600_000).catch((error: unknown) => {
    logger.error({ err: error }, 'could not schedule crm maintenance');
  });
  // Appointment reminders every five minutes (each appointment is claimed before sending).
  queue
    .schedule('calendar-reminders', 'calendar.reminders', {}, 5 * 60_000)
    .catch((error: unknown) => {
      logger.error({ err: error }, 'could not schedule appointment reminders');
    });
  // Durable workflow continuation: waits and retries that are due, and stalled runs.
  queue.schedule('automation-resume', 'automation.resume', {}, 60_000).catch((error: unknown) => {
    logger.error({ err: error }, 'could not schedule workflow resumption');
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
