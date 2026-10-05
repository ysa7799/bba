import { Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { WorkerEnv } from './env';
import { processSystemJob } from './processors/system';
import { QUEUES } from './queues';

export interface WorkerRuntime {
  workers: Worker[];
  close: () => Promise<void>;
}

export function startWorkers(deps: {
  env: WorkerEnv;
  redis: Redis;
  logger: Logger;
}): WorkerRuntime {
  const { env, redis, logger } = deps;
  const systemWorker = new Worker(QUEUES.system, processSystemJob(logger), {
    connection: redis,
    prefix: env.QUEUE_PREFIX,
    concurrency: env.WORKER_CONCURRENCY,
  });

  const workers = [systemWorker];
  for (const worker of workers) {
    worker.on('failed', (job, error) => {
      logger.error(
        {
          queue: worker.name,
          jobId: job?.id,
          jobName: job?.name,
          attempts: job?.attemptsMade,
          err: error,
        },
        'job failed',
      );
    });
    worker.on('error', (error) => {
      logger.error({ queue: worker.name, err: error }, 'worker error');
    });
  }

  return {
    workers,
    close: async () => {
      await Promise.all(workers.map((worker) => worker.close()));
    },
  };
}
