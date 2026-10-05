import { SecretBox } from '@businessos/shared';
import { z } from 'zod';
import {
  booleanFromEnv,
  logLevelSchema,
  nodeEnvSchema,
  parseEnv,
  postgresUrl,
  redisUrl,
} from '@businessos/config/env';

/** Email transports usable in production. */
const PRODUCTION_EMAIL_TRANSPORTS: readonly string[] = ['postmark'];

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
    EMAIL_TRANSPORT: z.enum(['log', 'file', 'postmark']).default('log'),
    EMAIL_FILE_PATH: z.string().min(1).optional(),
    /** Platform sender for transactional email (Postmark transport). */
    EMAIL_FROM: z.email().optional(),
    POSTMARK_SERVER_TOKEN: z.string().min(10).optional(),
    /** Public API URL (channel webhook callbacks, e.g. SMS delivery receipts). */
    API_PUBLIC_URL: z.url().default('http://localhost:4000'),
    /** Same keys as the API: decrypt channel credentials for sending. */
    CREDENTIALS_ENCRYPTION_KEYS: z
      .string()
      .optional()
      .refine((value) => {
        if (value === undefined || value === '') return true;
        try {
          SecretBox.fromConfig(value);
          return true;
        } catch {
          return false;
        }
      }, 'expected keyId:base64 pairs with 32-byte keys'),
    COMMUNICATIONS_FAKE_PROVIDERS: booleanFromEnv.default(false),
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
    if (env.EMAIL_TRANSPORT === 'postmark' && (!env.POSTMARK_SERVER_TOKEN || !env.EMAIL_FROM)) {
      ctx.addIssue({
        code: 'custom',
        path: ['POSTMARK_SERVER_TOKEN'],
        message: 'POSTMARK_SERVER_TOKEN and EMAIL_FROM are required for the postmark transport',
      });
    }
    if (env.NODE_ENV === 'production' && env.COMMUNICATIONS_FAKE_PROVIDERS) {
      ctx.addIssue({
        code: 'custom',
        path: ['COMMUNICATIONS_FAKE_PROVIDERS'],
        message: 'fake channel providers are not allowed in production',
      });
    }
    if (env.NODE_ENV === 'production' && !env.CREDENTIALS_ENCRYPTION_KEYS) {
      ctx.addIssue({
        code: 'custom',
        path: ['CREDENTIALS_ENCRYPTION_KEYS'],
        message: 'required in production',
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
