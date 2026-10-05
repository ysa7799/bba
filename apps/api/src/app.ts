import {
  createChannelProviders,
  type ChannelProviderRegistry,
  type CommunicationsServices,
} from '@businessos/communications';
import type { AuthConfig, AuthMailer } from '@businessos/auth';
import {
  createCalendarProviders,
  type CalendarProviderRegistry,
  type CalendarServices,
} from '@businessos/calendar';
import type { AutomationServices } from '@businessos/automation';
import { captchaFromEnv, type CaptchaVerifier } from '@businessos/forms';
import type { JobQueue } from '@businessos/jobs';
import type { PaymentProviderRegistry, PaymentServices } from '@businessos/payments';
import { type DatabaseHandle } from '@businessos/database';
import { LOG_REDACT_PATHS, newId, redactUrlForLog, SecretBox } from '@businessos/shared';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';
import type { ApiEnv } from './env';
import { QueueMailer } from './lib/mailer';
import { createPaymentProviders, paymentServices } from './lib/payments';
import { DEFAULT_RATE_LIMITS, RateLimiter, type RateLimitPolicies } from './lib/rate-limiter';
import { auditRoutes } from './modules/audit/routes';
import { automationRoutes, automationWebhookRoutes } from './modules/automation/routes';
import { authRoutes } from './modules/auth/routes';
import { billingCatalogRoutes, organizationBillingRoutes } from './modules/billing/routes';
import { calendarRoutes } from './modules/calendar/routes';
import { publicBookingRoutes } from './modules/calendar/public-routes';
import { crmRoutes } from './modules/crm/routes';
import { publicFormRoutes } from './modules/forms/public-routes';
import { RenderTokenStore } from './modules/forms/render-tokens';
import { formRoutes } from './modules/forms/routes';
import {
  communicationsRoutes,
  communicationWebhookRoutes,
  devCommunicationRoutes,
} from './modules/communications/routes';
import { healthRoutes } from './modules/health/routes';
import { invitationRoutes } from './modules/invitations/routes';
import { meRoutes } from './modules/me/routes';
import { organizationRoutes } from './modules/organizations/routes';
import {
  devPaymentRoutes,
  organizationPaymentRoutes,
  paymentConfigRoutes,
  paymentWebhookRoutes,
} from './modules/payments/routes';
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
  /** Payment providers (defaults to the configured ones; tests inject controllable fakes). */
  paymentProviders?: PaymentProviderRegistry;
  /** Messaging channel providers (defaults to the configured ones; tests inject fakes). */
  channelProviders?: ChannelProviderRegistry;
  /** Credential encryption (defaults to CREDENTIALS_ENCRYPTION_KEYS; tests inject a key). */
  secretBox?: SecretBox | null;
  /** External calendar providers (defaults to the live adapters, plus the fake when enabled). */
  calendarProviders?: CalendarProviderRegistry;
  /** Public-form captcha (defaults to Turnstile when configured, else none). */
  captcha?: CaptchaVerifier | null;
  /** Overrides for named rate-limit policies (tests use relaxed limits). */
  rateLimits?: Partial<RateLimitPolicies>;
  /** Log destination (defaults to stdout; tests capture log lines). */
  logStream?: { write(line: string): void };
}

export type ResolvedDependencies = AppDependencies & { mailer: AuthMailer };

declare module 'fastify' {
  interface FastifyInstance {
    deps: ResolvedDependencies;
    rateLimiter: RateLimiter;
    payments: PaymentServices;
    communications: CommunicationsServices;
    calendar: CalendarServices;
    forms: { captcha: CaptchaVerifier | null; renderTokens: RenderTokenStore };
    automation: AutomationServices;
  }
}

const INCOMING_REQUEST_ID = /^[A-Za-z0-9._-]{8,128}$/;

export async function buildApp(deps: AppDependencies): Promise<FastifyInstance> {
  const { env } = deps;
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      redact: { paths: [...LOG_REDACT_PATHS], censor: '[REDACTED]' },
      // Webhook URLs carry routing secrets (path token, verify_token query): masked in logs.
      serializers: {
        req: (request: FastifyRequest) => ({
          method: request.method,
          url: redactUrlForLog(request.url),
          host: request.host,
          remoteAddress: request.ip,
          remotePort: request.socket.remotePort,
        }),
      },
      ...(deps.logStream ? { stream: deps.logStream } : {}),
      ...(env.NODE_ENV === 'development' && !deps.logStream
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
  app.decorate(
    'payments',
    paymentServices(env, deps.paymentProviders ?? createPaymentProviders(env), deps.db.db, app.log),
  );
  app.decorate('communications', {
    providers:
      deps.channelProviders ?? createChannelProviders({ fake: env.COMMUNICATIONS_FAKE_PROVIDERS }),
    secretBox:
      deps.secretBox !== undefined
        ? deps.secretBox
        : env.CREDENTIALS_ENCRYPTION_KEYS
          ? SecretBox.fromConfig(env.CREDENTIALS_ENCRYPTION_KEYS)
          : null,
    publicApiUrl: env.API_PUBLIC_URL,
  } satisfies CommunicationsServices);
  app.decorate('calendar', {
    providers:
      deps.calendarProviders ?? createCalendarProviders({ fake: env.CALENDAR_FAKE_PROVIDERS }),
    secretBox: app.communications.secretBox,
  } satisfies CalendarServices);
  app.decorate('forms', {
    captcha: deps.captcha !== undefined ? deps.captcha : captchaFromEnv(env),
    renderTokens: new RenderTokenStore(deps.redis, env.REDIS_KEY_PREFIX),
  });
  app.decorate('automation', {
    allowPrivateNetwork: env.AUTOMATION_ALLOW_PRIVATE_NETWORK,
    ownHosts: [new URL(env.API_PUBLIC_URL).hostname, new URL(env.APP_URL).hostname],
    enqueue: (name, payload, options) =>
      deps.jobs.enqueue(name, payload as never, {
        organizationId: options.organizationId,
        ...(options.jobId ? { jobId: options.jobId } : {}),
        ...(options.delayMs ? { delayMs: options.delayMs } : {}),
        ...(options.correlationId ? { correlationId: options.correlationId } : {}),
      }),
  } satisfies AutomationServices);
  app.decorateRequest('tenant', null);

  app.addHook('onRequest', (request, reply, done) => {
    void reply.header('x-request-id', request.id);
    // Personal/tenant data must never be stored by browsers or shared caches.
    if (request.url.startsWith('/app/') || request.url.startsWith('/public/')) {
      void reply.header('cache-control', 'no-store');
    }
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
  await app.register(billingCatalogRoutes, { prefix: '/app/billing' });
  await app.register(organizationBillingRoutes, { prefix: '/app/orgs/:orgId/billing' });
  await app.register(paymentConfigRoutes, { prefix: '/app/billing' });
  await app.register(organizationPaymentRoutes, { prefix: '/app/orgs/:orgId/billing' });
  await app.register(paymentWebhookRoutes, { prefix: '/webhooks' });
  if (env.NODE_ENV !== 'production' && app.payments.providers.has('fake')) {
    await app.register(devPaymentRoutes, { prefix: '/app/dev' });
  }
  await app.register(invitationRoutes, { prefix: '/app/invitations' });
  await app.register(crmRoutes, { prefix: '/app/orgs/:orgId/crm' });
  await app.register(communicationsRoutes, { prefix: '/app/orgs/:orgId/communications' });
  await app.register(communicationWebhookRoutes, { prefix: '/webhooks/communications' });
  await app.register(calendarRoutes, { prefix: '/app/orgs/:orgId/calendar' });
  await app.register(publicBookingRoutes, { prefix: '/public/booking' });
  await app.register(formRoutes, { prefix: '/app/orgs/:orgId/forms' });
  await app.register(publicFormRoutes, { prefix: '/public/forms' });
  await app.register(automationRoutes, { prefix: '/app/orgs/:orgId/automation' });
  await app.register(automationWebhookRoutes, { prefix: '/webhooks/automation' });
  if (env.NODE_ENV !== 'production' && env.COMMUNICATIONS_FAKE_PROVIDERS) {
    await app.register(devCommunicationRoutes, { prefix: '/app/dev/communications/:orgId' });
  }

  return app;
}
