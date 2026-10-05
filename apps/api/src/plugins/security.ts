import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { RateLimitedError } from '@businessos/shared';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import type { ApiEnv } from '../env';

export async function registerSecurity(
  app: FastifyInstance,
  env: ApiEnv,
  redis: Redis,
): Promise<void> {
  // The API serves JSON only; a strict CSP is safe here. HSTS only matters behind HTTPS.
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    hsts: env.NODE_ENV === 'production',
    crossOriginResourcePolicy: { policy: 'same-site' },
  });

  const allowedOrigins = new Set(env.CORS_ORIGINS);
  await app.register(cors, {
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
    origin: (origin, callback) => {
      // Non-browser clients send no Origin header; CORS does not apply to them.
      if (origin === undefined || allowedOrigins.has(origin)) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
    maxAge: 600,
  });

  await app.register(rateLimit, {
    global: true,
    max: env.RATE_LIMIT_GLOBAL_PER_MINUTE,
    timeWindow: '1 minute',
    redis,
    nameSpace: `${env.REDIS_KEY_PREFIX}rl:global:`,
    // Availability over strictness when Redis is briefly unavailable; readiness reports it.
    skipOnError: true,
    errorResponseBuilder: (_request, context) =>
      new RateLimitedError(Math.max(1, Math.ceil(context.ttl / 1000))),
  });
}
