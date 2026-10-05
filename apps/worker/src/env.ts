import { z } from 'zod';
import {
  logLevelSchema,
  nodeEnvSchema,
  parseEnv,
  postgresUrl,
  redisUrl,
} from '@businessos/config/env';

/** Email transports usable in production. Empty until a real provider adapter exists. */
const PRODUCTION_EMAIL_TRANSPORTS: readonly string[] = [];

export const workerEnvSchema = z
  .object({
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
    /** Port for the liveness/readiness endpoint (0 disables it). */
    WORKER_HEALTH_PORT: z.coerce.number().int().min(0).max(65_535).default(0),
    /**
     * Email delivery: `log` (development) prints messages; `file` appends JSON lines (end-to-end
     * tests). Production requires a real provider (CONFIGURATION_REQUIRED until the email
     * provider phase).
     */
    EMAIL_TRANSPORT: z.enum(['log', 'file']).default('log'),
    EMAIL_FILE_PATH: z.string().min(1).optional(),
    OUTBOX_POLL_MS: z.coerce.number().int().min(50).max(60_000).default(500),
  })
  .superRefine((env, ctx) => {
    if (env.EMAIL_TRANSPORT === 'file' && !env.EMAIL_FILE_PATH) {
      ctx.addIssue({
        code: 'custom',
        path: ['EMAIL_FILE_PATH'],
        message: 'required for file email',
      });
    }
    if (
      env.NODE_ENV === 'production' &&
      !PRODUCTION_EMAIL_TRANSPORTS.includes(env.EMAIL_TRANSPORT)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['EMAIL_TRANSPORT'],
        message: 'a real email provider is required in production (CONFIGURATION_REQUIRED)',
      });
    }
  });

export type WorkerEnv = z.infer<typeof workerEnvSchema>;

export function loadWorkerEnv(source: Record<string, string | undefined> = process.env): WorkerEnv {
  return parseEnv(workerEnvSchema, source);
}
