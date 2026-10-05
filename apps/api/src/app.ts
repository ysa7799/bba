import type { AuthConfig, AuthMailer } from '@businessos/auth';
import type { JobQueue } from '@businessos/jobs';
import { type DatabaseHandle } from '@businessos/database';
import { LOG_REDACT_PATHS, newId } from '@businessos/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import type { ApiEnv } from './env';
import { QueueMailer } from './lib/mailer';
import { DEFAULT_RATE_LIMITS, RateLimiter, type RateLimitPolicies } from './lib/rate-limiter';
import { auditRoutes } from './modules/audit/routes';
import { authRoutes } from './modules/auth/routes';
import { healthRoutes } from './modules/health/routes';
import { invitationRoutes } from './modules/invitations/routes';
import { meRoutes } from './modules/me/routes';
import { organizationRoutes } from './modules/organizations/routes';
import { registerCsrfProtection } from './plugins/csrf';
import { registerErrorHandling } from './plugins/errors';
import { registerSecurity } from './plugins/security';
import { registerSession } from './plugins/session';

export interface AppDependencies {
  env: ApiEnv;
  db: DatabaseHandle;
  redis: Redis;
  /** Background job queue (BullMQ in production, in-memory in tests). */
  jobs: JobQueue;
  /** Auth email transport. Defaults to queueing `email.send` jobs for the worker. */
  mailer?: AuthMailer;
  authConfig: AuthConfig;
  /** Overrides for named rate-limit policies (tests use relaxed limits). */
  rateLimits?: Partial<RateLimitPolicies>;
}

export type ResolvedDependencies = AppDependencies & { mailer: AuthMailer };

declare module 'fastify' {
  interface FastifyInstance {
    deps: ResolvedDependencies;
    rateLimiter: RateLimiter;
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
    trustProxy:
      typeof env.TRUST_PROXY === 'number'
        ? (_address: string, hop: number) => hop < (env.TRUST_PROXY as number)
        : env.TRUST_PROXY,
    bodyLimit: 1_048_576,
    routerOptions: { maxParamLength: 200 },
  });

  app.decorate('deps', { ...deps, mailer: deps.mailer ?? new QueueMailer(deps.jobs) });
  app.decorate(
    'rateLimiter',
    new RateLimiter(
      deps.redis,
      env.REDIS_KEY_PREFIX,
      { ...DEFAULT_RATE_LIMITS, ...deps.rateLimits },
      app.log,
    ),
  );
  app.decorateRequest('tenant', null);

  app.addHook('onRequest', (request, reply, done) => {
    void reply.header('x-request-id', request.id);
    // Personal/tenant data must never be stored by browsers or shared caches.
    if (request.url.startsWith('/app/')) void reply.header('cache-control', 'no-store');
    done();
  });

  registerErrorHandling(app);
  await registerSecurity(app, env, deps.redis);
  registerCsrfProtection(app);
  await registerSession(app);

  await app.register(healthRoutes, { prefix: '/health' });
  await app.register(authRoutes, { prefix: '/app/auth' });
  await app.register(meRoutes, { prefix: '/app/me' });
  await app.register(organizationRoutes, { prefix: '/app/orgs' });
  await app.register(auditRoutes, { prefix: '/app/orgs/:orgId/audit-logs' });
  await app.register(invitationRoutes, { prefix: '/app/invitations' });

  return app;
}
