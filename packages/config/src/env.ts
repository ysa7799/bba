import { z } from 'zod';

/**
 * Parse and validate environment variables against a Zod schema.
 * Fails fast with a readable message that lists variable names only (never values).
 */
export function parseEnv<T extends z.ZodType>(
  schema: T,
  source: Record<string, string | undefined> = process.env,
): z.infer<T> {
  const result = schema.safeParse(source);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }
  return result.data;
}

/** Boolean env var parser accepting true/false/1/0. */
export const booleanFromEnv = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

export const nodeEnvSchema = z.enum(['development', 'test', 'production']).default('development');

export const logLevelSchema = z
  .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
  .default('info');

/** Comma-separated list → string[] (trimmed, empty entries removed). */
export const csvList = z
  .string()
  .default('')
  .transform((value) =>
    value
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
  );

export const postgresUrl = z
  .url()
  .refine((value) => /^postgres(ql)?:\/\//.test(value), 'must be a postgres:// URL');

export const redisUrl = z
  .url()
  .refine((value) => /^rediss?:\/\//.test(value), 'must be a redis:// or rediss:// URL');
