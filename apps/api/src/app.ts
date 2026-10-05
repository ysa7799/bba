import { type DatabaseHandle } from '@businessos/database';
import { LOG_REDACT_PATHS, newId } from '@businessos/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import type { ApiEnv } from './env';
import { healthRoutes } from './modules/health/routes';
import { registerErrorHandling } from './plugins/errors';
import { registerSecurity } from './plugins/security';

export interface AppDependencies {
  env: ApiEnv;
  db: DatabaseHandle;
  redis: Redis;
}

declare module 'fastify' {
  interface FastifyInstance {
    deps: AppDependencies;
  }
}

const INCOMING_REQUEST_ID = /^[A-Za-z0-9._-]{8,128}$/;

export async function buildApp(deps: AppDependencies): Promise<FastifyInstance> {
  const { env } = deps;
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      redact: { paths: [...LOG_REDACT_PATHS], censor: '[REDACTED]' },
      ...(env.NODE_ENV === 'development'
        ? { transport: { target: 'pino-pretty', options: { singleLine: true } } }
        : {}),
    },
    // Accept a well-formed upstream request id (from the web proxy / load balancer) for
    // correlation; otherwise generate one.
    genReqId: (request) => {
      const incoming = request.headers['x-request-id'];
      return typeof incoming === 'string' && INCOMING_REQUEST_ID.test(incoming)
        ? incoming
        : newId();
    },
    trustProxy: env.TRUST_PROXY,
    bodyLimit: 1_048_576,
    routerOptions: { maxParamLength: 200 },
  });

  app.decorate('deps', deps);

  app.addHook('onRequest', (request, reply, done) => {
    void reply.header('x-request-id', request.id);
    done();
  });

  registerErrorHandling(app);
  await registerSecurity(app, env, deps.redis);

  await app.register(healthRoutes, { prefix: '/health' });

  return app;
}
