import { SecretBox } from '@businessos/shared';
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
    /** BullMQ key prefix shared with the worker. */
    QUEUE_PREFIX: z
      .string()
      .regex(/^[a-z0-9:_-]+$/)
      .default('bos'),
    /** Public URL of this API (payment provider webhooks are sent here). */
    API_PUBLIC_URL: z.url().default('http://localhost:4000'),
    /** Payment provider for checkouts: none (disabled), fake (development/tests), tap. */
    PAYMENTS_PROVIDER: z.enum(['none', 'fake', 'tap']).default('none'),
    TAP_SECRET_KEY: z.string().min(10).optional(),
    TAP_API_BASE_URL: z.url().optional(),
    FAKE_PAYMENTS_WEBHOOK_SECRET: z.string().min(16).default('dev-fake-payments-webhook-secret'),
    /**
     * Keys sealing stored provider credentials (`keyId:base64-32-bytes`, comma separated; the
     * first encrypts, all decrypt). Without it channels can be created but not configured.
     */
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
    /** Development/test in-memory external calendar provider. */
    CALENDAR_FAKE_PROVIDERS: booleanFromEnv.default(false),
    /** Development/test fake channel providers. */
    COMMUNICATIONS_FAKE_PROVIDERS: booleanFromEnv.default(false),
    /**
     * Cloudflare Turnstile for public forms (both or neither). The site key is public; the
     * secret only ever stays on the server. Without them captcha is CONFIGURATION_REQUIRED.
     */
    TURNSTILE_SITE_KEY: z.string().min(10).max(200).optional(),
    TURNSTILE_SECRET_KEY: z.string().min(10).max(200).optional(),
    /** Development/test captcha that accepts the token `pass`. */
    FORMS_FAKE_CAPTCHA: booleanFromEnv.default(false),
    PASSWORD_HASH_MEMORY_KIB: z.coerce.number().int().min(1024).max(1_048_576).default(19_456),
    PASSWORD_HASH_TIME_COST: z.coerce.number().int().min(1).max(10).default(2),
  })
  .superRefine((env, ctx) => {
    if (env.PAYMENTS_PROVIDER === 'tap' && !env.TAP_SECRET_KEY && env.NODE_ENV === 'production') {
      ctx.addIssue({
        code: 'custom',
        path: ['TAP_SECRET_KEY'],
        message: 'required when PAYMENTS_PROVIDER=tap in production',
      });
    }
    if (Boolean(env.TURNSTILE_SITE_KEY) !== Boolean(env.TURNSTILE_SECRET_KEY)) {
      ctx.addIssue({
        code: 'custom',
        path: ['TURNSTILE_SECRET_KEY'],
        message: 'set both TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY, or neither',
      });
    }
    if (env.NODE_ENV !== 'production') return;
    if (env.FORMS_FAKE_CAPTCHA) {
      ctx.addIssue({
        code: 'custom',
        path: ['FORMS_FAKE_CAPTCHA'],
        message: 'the fake captcha is not allowed in production',
      });
    }
    if (env.PAYMENTS_PROVIDER === 'fake') {
      ctx.addIssue({
        code: 'custom',
        path: ['PAYMENTS_PROVIDER'],
        message: 'the fake payment provider is not allowed in production',
      });
    }
    if (env.COMMUNICATIONS_FAKE_PROVIDERS) {
      ctx.addIssue({
        code: 'custom',
        path: ['COMMUNICATIONS_FAKE_PROVIDERS'],
        message: 'fake channel providers are not allowed in production',
      });
    }
    if (env.CALENDAR_FAKE_PROVIDERS) {
      ctx.addIssue({
        code: 'custom',
        path: ['CALENDAR_FAKE_PROVIDERS'],
        message: 'the fake calendar provider is not allowed in production',
      });
    }
    if (!env.CREDENTIALS_ENCRYPTION_KEYS) {
      ctx.addIssue({
        code: 'custom',
        path: ['CREDENTIALS_ENCRYPTION_KEYS'],
        message: 'required in production (provider credentials are encrypted at rest)',
      });
    }
    if (!env.API_PUBLIC_URL.startsWith('https://')) {
      ctx.addIssue({
        code: 'custom',
        path: ['API_PUBLIC_URL'],
        message: 'must use https in production',
      });
    }
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
