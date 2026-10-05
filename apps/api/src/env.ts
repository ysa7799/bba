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

/** Mail transports acceptable in production. Empty until a real provider adapter exists. */
const PRODUCTION_MAIL_TRANSPORTS: readonly string[] = [];

export const apiEnvSchema = z
  .object({
    NODE_ENV: nodeEnvSchema,
    LOG_LEVEL: logLevelSchema,
    DATABASE_URL: postgresUrl,
    DB_POOL_MAX: z.coerce.number().int().min(1).max(200).default(10),
    REDIS_URL: redisUrl,
    /** Namespace for all Redis keys written by the API (rate limits, caches). */
    REDIS_KEY_PREFIX: z
      .string()
      .regex(/^[a-z0-9:_-]+$/)
      .default('bos:'),
    API_HOST: z.string().min(1).default('0.0.0.0'),
    API_PORT: z.coerce.number().int().min(0).max(65_535).default(4000),
    CORS_ORIGINS: csvList,
    APP_URL: z.url(),
    /**
     * Which upstream proxies may set X-Forwarded-For: `false` (default), `true` (any — only when
     * the API is unreachable except through trusted proxies), a hop count, or a comma-separated
     * list of proxy IPs/CIDRs.
     */
    TRUST_PROXY: z
      .string()
      .default('false')
      .transform((value): boolean | number | string => {
        const trimmed = value.trim();
        if (trimmed === 'true') return true;
        if (trimmed === 'false' || trimmed === '') return false;
        if (/^\d+$/.test(trimmed)) return Number(trimmed);
        return trimmed;
      }),
    RATE_LIMIT_GLOBAL_PER_MINUTE: z.coerce.number().int().min(1).default(600),
    /** Secure cookies; defaults to true in production and is mandatory there. */
    COOKIE_SECURE: booleanFromEnv.optional(),
    /**
     * Where auth emails go. `log` (development only) prints links to the server log; `memory`
     * is for tests; `file` appends JSON lines for end-to-end tests. Production requires a real provider (CONFIGURATION_REQUIRED until the
     * notification/email phase lands).
     */
    MAIL_TRANSPORT: z.enum(['log', 'memory', 'file']).default('log'),
    /** JSON-lines sink for `MAIL_TRANSPORT=file` (end-to-end tests). */
    MAIL_FILE_PATH: z.string().min(1).optional(),
    PASSWORD_HASH_MEMORY_KIB: z.coerce.number().int().min(1024).max(1_048_576).default(19_456),
    PASSWORD_HASH_TIME_COST: z.coerce.number().int().min(1).max(10).default(2),
  })
  .superRefine((env, ctx) => {
    if (env.MAIL_TRANSPORT === 'file' && !env.MAIL_FILE_PATH) {
      ctx.addIssue({ code: 'custom', path: ['MAIL_FILE_PATH'], message: 'required for file mail' });
    }
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
    if (env.COOKIE_SECURE === false) {
      ctx.addIssue({
        code: 'custom',
        path: ['COOKIE_SECURE'],
        message: 'must be true in production',
      });
    }
    if (!PRODUCTION_MAIL_TRANSPORTS.includes(env.MAIL_TRANSPORT)) {
      ctx.addIssue({
        code: 'custom',
        path: ['MAIL_TRANSPORT'],
        message: 'a real email provider is required in production (CONFIGURATION_REQUIRED)',
      });
    }
    if (env.PASSWORD_HASH_MEMORY_KIB < 19_456 || env.PASSWORD_HASH_TIME_COST < 2) {
      ctx.addIssue({
        code: 'custom',
        path: ['PASSWORD_HASH_MEMORY_KIB'],
        message: 'argon2id parameters below the OWASP baseline are not allowed in production',
      });
    }
  });

export type ApiEnv = z.infer<typeof apiEnvSchema>;

export function loadApiEnv(source: Record<string, string | undefined> = process.env): ApiEnv {
  return parseEnv(apiEnvSchema, source);
}

export function cookieSecure(env: ApiEnv): boolean {
  return env.COOKIE_SECURE ?? env.NODE_ENV === 'production';
}

/** The web app's origin plus explicitly allowed CORS origins. */
export function allowedOrigins(env: ApiEnv): Set<string> {
  return new Set([new URL(env.APP_URL).origin, ...env.CORS_ORIGINS]);
}
