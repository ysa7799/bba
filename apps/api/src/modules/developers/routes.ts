import { createApiKey, listApiKeys, PUBLIC_API_SCOPES, revokeApiKey } from '@businessos/api-keys';
import { recordAudit } from '@businessos/audit';
import { canUseFeature, requireFeature } from '@businessos/billing';
import { withTenant, type TenantTx } from '@businessos/database';
import { PERMISSION_DEFINITIONS } from '@businessos/permissions';
import {
  attemptJobId,
  createTestDelivery,
  createWebhookEndpoint,
  deleteWebhookEndpoint,
  getDelivery,
  getWebhookEndpoint,
  listDeliveries,
  listWebhookEndpoints,
  prepareRedelivery,
  rotateWebhookSecret,
  updateWebhookEndpoint,
  WEBHOOK_EVENT_TYPES,
} from '@businessos/webhooks';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { auditContext } from '../../lib/http';
import { parseInput } from '../../lib/validation';
import {
  requirePermission,
  resolveTenant,
  tenantScope,
  type TenantContext,
} from '../../plugins/tenant';

const idParams = z.object({ id: z.uuid() });
const deliveryParams = z.object({ id: z.uuid(), deliveryId: z.uuid() });

const SCOPE_LABELS = new Map<string, string>(
  PERMISSION_DEFINITIONS.map((definition) => [definition.key, definition.label]),
);

/** Host only: a URL's path or query may carry the customer's own routing secrets. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid';
  }
}

/**
 * `/app/orgs/:orgId/developers` — API keys and webhook endpoints. Managing them needs
 * `api.manage`; creating keys, endpoints and test events also needs the plan's `api.enabled`
 * (existing ones stay visible and revocable after a downgrade).
 */
export function developerRoutes(app: FastifyInstance): void {
  const db = () => app.deps.db.db;

  app.addHook('preHandler', async (request) => {
    await resolveTenant(request);
  });

  function inTenant<T>(tenant: TenantContext, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    return withTenant(db(), tenantScope(tenant), fn);
  }

  function audit(
    tx: TenantTx,
    request: FastifyRequest,
    tenant: TenantContext,
    action: Parameters<typeof recordAudit>[2]['action'],
    target: { type: string; id: string },
    metadata?: Record<string, unknown>,
  ) {
    return recordAudit(tx, auditContext(request), {
      organizationId: tenant.organizationId,
      action,
      target,
      metadata,
    });
  }

  function queueAttempt(organizationId: string, deliveryId: string, attempt: number) {
    return app.webhooks.enqueueAttempt({
      organizationId,
      deliveryId,
      attempt,
      // Unique per request: a manual send must not be swallowed by a queued retry's id.
      jobId: attemptJobId(deliveryId, attempt, `m${Date.now()}`),
      delayMs: 0,
    });
  }

  app.get('/', async (request) => {
    const tenant = requirePermission(request, 'api.manage');
    const enabled = await inTenant(tenant, (tx) =>
      canUseFeature(tx, tenant.organizationId, 'api.enabled'),
    );
    return {
      enabled,
      apiBaseUrl: `${app.publicApiBaseUrl}/api/v1`,
      // Only scopes this member holds can be given to a key.
      scopes: PUBLIC_API_SCOPES.filter((scope) => tenant.permissions.has(scope)).map((scope) => ({
        scope,
        label: SCOPE_LABELS.get(scope) ?? scope,
      })),
      eventTypes: WEBHOOK_EVENT_TYPES,
    };
  });

  // ── API keys ──────────────────────────────────────────────────────────────────────────────
  app.get('/api-keys', async (request) => {
    const tenant = requirePermission(request, 'api.manage');
    return { data: await inTenant(tenant, (tx) => listApiKeys(tx, tenant.organizationId)) };
  });

  app.post('/api-keys', async (request, reply) => {
    const tenant = requirePermission(request, 'api.manage');
    const result = await inTenant(tenant, async (tx) => {
      await requireFeature(tx, tenant.organizationId, 'api.enabled');
      const issued = await createApiKey(
        tx,
        {
          organizationId: tenant.organizationId,
          userId: tenant.userId,
          permissions: tenant.permissions,
        },
        request.body as Parameters<typeof createApiKey>[2],
      );
      await audit(
        tx,
        request,
        tenant,
        'api_key.created',
        { type: 'api_key', id: issued.apiKey.id },
        {
          name: issued.apiKey.name,
          prefix: issued.apiKey.prefix,
          scopes: issued.apiKey.scopes,
          expiresAt: issued.apiKey.expiresAt,
        },
      );
      return issued;
    });
    // The key itself is in this response only; it cannot be shown again.
    return reply.status(201).send({ apiKey: result.apiKey, key: result.key });
  });

  app.post('/api-keys/:id/revoke', async (request) => {
    const tenant = requirePermission(request, 'api.manage');
    const { id } = parseInput(idParams, request.params);
    const apiKey = await inTenant(tenant, async (tx) => {
      const revoked = await revokeApiKey(tx, tenant.organizationId, id, tenant.userId);
      await audit(
        tx,
        request,
        tenant,
        'api_key.revoked',
        { type: 'api_key', id },
        {
          name: revoked.name,
          prefix: revoked.prefix,
        },
      );
      return revoked;
    });
    return { apiKey };
  });

  // ── Webhook endpoints ─────────────────────────────────────────────────────────────────────
  app.get('/webhooks', async (request) => {
    const tenant = requirePermission(request, 'api.manage');
    return {
      data: await inTenant(tenant, (tx) => listWebhookEndpoints(tx, tenant.organizationId)),
    };
  });

  app.post('/webhooks', async (request, reply) => {
    const tenant = requirePermission(request, 'api.manage');
    const result = await inTenant(tenant, async (tx) => {
      await requireFeature(tx, tenant.organizationId, 'api.enabled');
      const created = await createWebhookEndpoint(
        tx,
        { organizationId: tenant.organizationId, userId: tenant.userId },
        app.webhooks.secretBox,
        app.webhooks,
        request.body as Parameters<typeof createWebhookEndpoint>[4],
      );
      await audit(
        tx,
        request,
        tenant,
        'webhook.created',
        { type: 'webhook_endpoint', id: created.endpoint.id },
        { host: hostOf(created.endpoint.url), events: created.endpoint.events },
      );
      return created;
    });
    // The signing secret is in this response only; rotating it issues a new one.
    return reply.status(201).send({ endpoint: result.endpoint, secret: result.secret });
  });

  app.get('/webhooks/:id', async (request) => {
    const tenant = requirePermission(request, 'api.manage');
    const { id } = parseInput(idParams, request.params);
    return {
      endpoint: await inTenant(tenant, (tx) => getWebhookEndpoint(tx, tenant.organizationId, id)),
    };
  });

  app.patch('/webhooks/:id', async (request) => {
    const tenant = requirePermission(request, 'api.manage');
    const { id } = parseInput(idParams, request.params);
    const { endpoint } = await inTenant(tenant, async (tx) => {
      const updated = await updateWebhookEndpoint(
        tx,
        tenant.organizationId,
        id,
        app.webhooks,
        request.body as Parameters<typeof updateWebhookEndpoint>[4],
      );
      if (updated.changedFields.length > 0) {
        await audit(
          tx,
          request,
          tenant,
          'webhook.updated',
          { type: 'webhook_endpoint', id },
          { changedFields: updated.changedFields, host: hostOf(updated.endpoint.url) },
        );
      }
      return updated;
    });
    return { endpoint };
  });

  app.delete('/webhooks/:id', async (request, reply) => {
    const tenant = requirePermission(request, 'api.manage');
    const { id } = parseInput(idParams, request.params);
    await inTenant(tenant, async (tx) => {
      const deleted = await deleteWebhookEndpoint(tx, tenant.organizationId, id);
      await audit(
        tx,
        request,
        tenant,
        'webhook.deleted',
        { type: 'webhook_endpoint', id },
        {
          host: hostOf(deleted.url),
        },
      );
    });
    return reply.status(204).send();
  });

  app.post('/webhooks/:id/rotate-secret', async (request) => {
    const tenant = requirePermission(request, 'api.manage');
    const { id } = parseInput(idParams, request.params);
    return inTenant(tenant, async (tx) => {
      const rotated = await rotateWebhookSecret(
        tx,
        tenant.organizationId,
        id,
        app.webhooks.secretBox,
      );
      await audit(tx, request, tenant, 'webhook.secret_rotated', {
        type: 'webhook_endpoint',
        id,
      });
      return { endpoint: rotated.endpoint, secret: rotated.secret };
    });
  });

  app.post('/webhooks/:id/test', async (request, reply) => {
    const tenant = requirePermission(request, 'api.manage');
    const { id } = parseInput(idParams, request.params);
    await app.rateLimiter.consume('webhookSendUser', tenant.userId);
    const delivery = await inTenant(tenant, async (tx) => {
      await requireFeature(tx, tenant.organizationId, 'api.enabled');
      return createTestDelivery(tx, tenant.organizationId, id);
    });
    await queueAttempt(tenant.organizationId, delivery.id, 1);
    return reply.status(202).send({ deliveryId: delivery.id });
  });

  app.get('/webhooks/:id/deliveries', async (request) => {
    const tenant = requirePermission(request, 'api.manage');
    const { id } = parseInput(idParams, request.params);
    return inTenant(tenant, async (tx) => {
      // 404 for an endpoint that is not this organization's.
      await getWebhookEndpoint(tx, tenant.organizationId, id);
      return listDeliveries(
        tx,
        tenant.organizationId,
        id,
        request.query as Parameters<typeof listDeliveries>[3],
      );
    });
  });

  app.get('/webhooks/:id/deliveries/:deliveryId', async (request) => {
    const tenant = requirePermission(request, 'api.manage');
    const { id, deliveryId } = parseInput(deliveryParams, request.params);
    return {
      delivery: await inTenant(tenant, (tx) =>
        getDelivery(tx, tenant.organizationId, id, deliveryId),
      ),
    };
  });

  app.post('/webhooks/:id/deliveries/:deliveryId/redeliver', async (request, reply) => {
    const tenant = requirePermission(request, 'api.manage');
    const { id, deliveryId } = parseInput(deliveryParams, request.params);
    await app.rateLimiter.consume('webhookSendUser', tenant.userId);
    const { attempt } = await inTenant(tenant, async (tx) => {
      await requireFeature(tx, tenant.organizationId, 'api.enabled');
      return prepareRedelivery(tx, tenant.organizationId, id, deliveryId);
    });
    await queueAttempt(tenant.organizationId, deliveryId, attempt);
    return reply.status(202).send({ deliveryId });
  });
}
