import { z } from 'zod';
import {
  booleanFromEnv,
  csvList,
  logLevelSchema,
  nodeEnvSchema,
  parseEnv,
  postgresUrl,
  redisUrl,
} from '@businessos/config/env';

export const apiEnvSchema = z
  .object({
    NODE_ENV: nodeEnvSchema,
    LOG_LEVEL: logLevelSchema,
    DATABASE_URL: postgresUrl,
    DB_POOL_MAX: z.coerce.number().int().min(1).max(200).default(10),
    REDIS_URL: redisUrl,
    API_HOST: z.string().min(1).default('0.0.0.0'),
    API_PORT: z.coerce.number().int().min(0).max(65_535).default(4000),
    CORS_ORIGINS: csvList,
    APP_URL: z.url(),
    TRUST_PROXY: booleanFromEnv.default(false),
    RATE_LIMIT_GLOBAL_PER_MINUTE: z.coerce.number().int().min(1).default(600),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;
    if (!env.APP_URL.startsWith('https://')) {
      ctx.addIssue({ code: 'custom', path: ['APP_URL'], message: 'must use https in production' });
    }
    for (const origin of env.CORS_ORIGINS) {
      if (!origin.startsWith('https://')) {
        ctx.addIssue({
          code: 'custom',
          path: ['CORS_ORIGINS'],
          message: 'all origins must use https in production',
        });
      }
    }
  });

export type ApiEnv = z.infer<typeof apiEnvSchema>;

export function loadApiEnv(source: Record<string, string | undefined> = process.env): ApiEnv {
  return parseEnv(apiEnvSchema, source);
}
