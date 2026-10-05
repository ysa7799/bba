import { LOG_REDACT_PATHS } from '@businessos/shared';
import { pino, type Logger } from 'pino';
import type { WorkerEnv } from './env';

export function createLogger(env: Pick<WorkerEnv, 'LOG_LEVEL' | 'NODE_ENV'>): Logger {
  return pino({
    name: 'businessos-worker',
    level: env.LOG_LEVEL,
    redact: { paths: [...LOG_REDACT_PATHS], censor: '[REDACTED]' },
    ...(env.NODE_ENV === 'development'
      ? { transport: { target: 'pino-pretty', options: { singleLine: true } } }
      : {}),
  });
}
