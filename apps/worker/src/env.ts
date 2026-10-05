import { z } from 'zod';
import {
  logLevelSchema,
  nodeEnvSchema,
  parseEnv,
  postgresUrl,
  redisUrl,
} from '@businessos/config/env';

export const workerEnvSchema = z.object({
  NODE_ENV: nodeEnvSchema,
  LOG_LEVEL: logLevelSchema,
  DATABASE_URL: postgresUrl,
  DB_POOL_MAX: z.coerce.number().int().min(1).max(200).default(10),
  REDIS_URL: redisUrl,
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(5),
  QUEUE_PREFIX: z
    .string()
    .regex(/^[a-z0-9:_-]+$/)
    .default('bos'),
});

export type WorkerEnv = z.infer<typeof workerEnvSchema>;

export function loadWorkerEnv(source: Record<string, string | undefined> = process.env): WorkerEnv {
  return parseEnv(workerEnvSchema, source);
}
