import { recordAudit, type AuditAction } from '@businessos/audit';
import {
  ACTION_TYPES,
  archiveWorkflow,
  cancelRun,
  createWorkflow,
  discardWorkflowDraft,
  findWorkflowByWebhookToken,
  getRun,
  getWorkflow,
  listRuns,
  listWorkflows,
  publishWorkflow,
  retryRun,
  rotateWebhookToken,
  runCorrelationId,
  runListQuerySchema,
  saveWorkflowDraft,
  setWorkflowPaused,
  startRunFromWebhook,
  TRIGGER_TYPES,
  updateWorkflow,
  workflowListQuerySchema,
} from '@businessos/automation';
import { listAppointmentTypes } from '@businessos/calendar';
import { listConnections, listTemplates } from '@businessos/communications';
import {
  listAssignees,
  listCustomFields,
  listPipelines,
  listTags,
  type CrmContext,
} from '@businessos/crm';
import { withTenant, type TenantTx } from '@businessos/database';
import { listForms } from '@businessos/forms';
import { ValidationError } from '@businessos/shared';
import { randomUUID } from 'node:crypto';
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

function context(request: FastifyRequest, tenant: TenantContext): CrmContext {
  return {
    organizationId: tenant.organizationId,
    countryCode: tenant.organization.countryCode,
    defaultCurrency: tenant.organization.defaultCurrency,
    timezone: tenant.organization.timezone,
    actor: { type: 'user', userId: tenant.userId, correlationId: request.id },
    canRead: {
      contact: tenant.permissions.has('crm.contact.read'),
      company: tenant.permissions.has('crm.company.read'),
      deal: tenant.permissions.has('crm.deal.read'),
    },
  };
}

/** `/app/orgs/:orgId/automation/*` — workflows, publishing, runs. */
export function automationRoutes(app: FastifyInstance): void {
  const db = () => app.deps.db.db;
  const options = () => ({
    allowPrivateNetwork: app.automation.allowPrivateNetwork,
    ownHosts: app.automation.ownHosts ?? [],
  });

  app.addHook('preHandler', async (request) => {
    await resolveTenant(request);
  });

  function run<T>(
    request: FastifyRequest,
    tenant: TenantContext,
    fn: (tx: TenantTx, ctx: CrmContext) => Promise<T>,
  ): Promise<T> {
    return withTenant(db(), tenantScope(tenant), (tx) => fn(tx, context(request, tenant)));
  }

  function audit(
    tx: TenantTx,
    request: FastifyRequest,
    tenant: TenantContext,
    action: AuditAction,
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

  app.get('/workflows', async (request) => {
    const tenant = requirePermission(request, 'automation.workflow.read');
    const query = parseInput(workflowListQuerySchema, request.query);
    return run(request, tenant, (tx) => listWorkflows(tx, tenant.organizationId, query));
  });

  /** Everything the builder offers (triggers, steps and the records they can point at). */
  app.get('/builder-options', async (request) => {
    const tenant = requirePermission(request, 'automation.workflow.manage');
    return run(request, tenant, async (tx) => {
      const organizationId = tenant.organizationId;
      const connections = await listConnections(tx, organizationId, app.communications);
      return {
        triggers: TRIGGER_TYPES,
        actions: ACTION_TYPES,
        tags: await listTags(tx, organizationId),
        pipelines: (await listPipelines(tx, organizationId)).map((pipeline) => ({
          id: pipeline.id,
          name: pipeline.name,
          stages: pipeline.stages.map((stage) => ({
            id: stage.id,
            name: stage.name,
            kind: stage.kind,
          })),
        })),
        members: await listAssignees(tx, organizationId),
        channels: connections.map((connection) => ({
          id: connection.id,
          channel: connection.channel,
          name: connection.name,
          status: connection.status,
        })),
        whatsappTemplates: (await listTemplates(tx, organizationId)).map((template) => ({
          connectionId: template.connectionId,
          name: template.name,
          language: template.language,
          variableCount: template.variableCount,
        })),
        forms: (await listForms(tx, organizationId, { status: 'active' })).data.map((form) => ({
          id: form.id,
          name: form.name,
        })),
        appointmentTypes: (await listAppointmentTypes(tx, organizationId)).map((type) => ({
          id: type.id,
          name: type.name,
        })),
        contactFields: (await listCustomFields(tx, organizationId, { entityType: 'contact' })).map(
          (field) => ({ key: field.key, label: field.label, type: field.type }),
        ),
      };
    });
  });

  app.post('/workflows', async (request, reply) => {
    const tenant = requirePermission(request, 'automation.workflow.manage');
    const workflow = await run(request, tenant, async (tx, ctx) => {
      const created = await createWorkflow(
        tx,
        ctx,
        request.body as Parameters<typeof createWorkflow>[2],
      );
      await audit(tx, request, tenant, 'automation.workflow.created', {
        type: 'workflow',
        id: created.id,
      });
      return created;
    });
    return reply.status(201).send({ workflow });
  });

  app.get('/workflows/:id', async (request) => {
    const tenant = requirePermission(request, 'automation.workflow.read');
    const { id } = parseInput(idParams, request.params);
    return {
      workflow: await run(request, tenant, (tx) => getWorkflow(tx, tenant.organizationId, id)),
    };
  });

  app.patch('/workflows/:id', async (request) => {
    const tenant = requirePermission(request, 'automation.workflow.manage');
    const { id } = parseInput(idParams, request.params);
    const workflow = await run(request, tenant, async (tx, ctx) => {
      const result = await updateWorkflow(
        tx,
        ctx,
        id,
        request.body as Parameters<typeof updateWorkflow>[3],
      );
      if (result.changedFields.length > 0) {
        await audit(
          tx,
          request,
          tenant,
          'automation.workflow.updated',
          { type: 'workflow', id },
          { changedFields: result.changedFields },
        );
      }
      return result.workflow;
    });
    return { workflow };
  });

  app.put('/workflows/:id/draft', async (request) => {
    const tenant = requirePermission(request, 'automation.workflow.manage');
    const { id } = parseInput(idParams, request.params);
    const workflow = await run(request, tenant, async (tx, ctx) => {
      const saved = await saveWorkflowDraft(
        tx,
        ctx,
        id,
        request.body as Parameters<typeof saveWorkflowDraft>[3],
        options(),
      );
      await audit(
        tx,
        request,
        tenant,
        'automation.workflow.updated',
        { type: 'workflow', id },
        { changedFields: ['draft'], draftVersion: saved.draft?.number ?? null },
      );
      return saved;
    });
    return { workflow };
  });

  app.delete('/workflows/:id/draft', async (request) => {
    const tenant = requirePermission(request, 'automation.workflow.manage');
    const { id } = parseInput(idParams, request.params);
    return {
      workflow: await run(request, tenant, (tx, ctx) => discardWorkflowDraft(tx, ctx, id)),
    };
  });

  app.post('/workflows/:id/publish', async (request) => {
    const tenant = requirePermission(request, 'automation.workflow.manage');
    const { id } = parseInput(idParams, request.params);
    const workflow = await run(request, tenant, async (tx, ctx) => {
      const published = await publishWorkflow(tx, ctx, id, options());
      await audit(
        tx,
        request,
        tenant,
        'automation.workflow.published',
        { type: 'workflow', id },
        { version: published.publishedVersion },
      );
      return published;
    });
    return { workflow };
  });

  for (const [path, paused, action] of [
    ['/workflows/:id/pause', true, 'automation.workflow.paused'],
    ['/workflows/:id/resume', false, 'automation.workflow.resumed'],
  ] as const) {
    app.post(path, async (request) => {
      const tenant = requirePermission(request, 'automation.workflow.manage');
      const { id } = parseInput(idParams, request.params);
      const workflow = await run(request, tenant, async (tx, ctx) => {
        const changed = await setWorkflowPaused(tx, ctx, id, paused);
        await audit(tx, request, tenant, action, { type: 'workflow', id });
        return changed;
      });
      return { workflow };
    });
  }

  app.post('/workflows/:id/archive', async (request) => {
    const tenant = requirePermission(request, 'automation.workflow.manage');
    const { id } = parseInput(idParams, request.params);
    const result = await run(request, tenant, async (tx, ctx) => {
      const archived = await archiveWorkflow(tx, ctx, id);
      await audit(
        tx,
        request,
        tenant,
        'automation.workflow.archived',
        { type: 'workflow', id },
        { cancelledRuns: archived.cancelledRuns },
      );
      return archived;
    });
    return result;
  });

  /** New inbound webhook URL (shown once; the previous one stops working). */
  app.post('/workflows/:id/webhook-token', async (request) => {
    const tenant = requirePermission(request, 'automation.workflow.manage');
    const { id } = parseInput(idParams, request.params);
    const { token } = await run(request, tenant, async (tx, ctx) => {
      const rotated = await rotateWebhookToken(tx, ctx, id);
      await audit(tx, request, tenant, 'automation.workflow.webhook_rotated', {
        type: 'workflow',
        id,
      });
      return rotated;
    });
    return {
      url: `${app.deps.env.API_PUBLIC_URL.replace(/\/$/, '')}/webhooks/automation/${token}`,
    };
  });

  app.get('/workflows/:id/runs', async (request) => {
    const tenant = requirePermission(request, 'automation.workflow.read');
    const { id } = parseInput(idParams, request.params);
    const query = parseInput(runListQuerySchema, request.query);
    return run(request, tenant, (tx, ctx) => listRuns(tx, ctx, id, query));
  });

  app.get('/runs/:id', async (request) => {
    const tenant = requirePermission(request, 'automation.workflow.read');
    const { id } = parseInput(idParams, request.params);
    return { run: await run(request, tenant, (tx, ctx) => getRun(tx, ctx, id)) };
  });

  app.post('/runs/:id/retry', async (request) => {
    const tenant = requirePermission(request, 'automation.workflow.manage');
    const { id } = parseInput(idParams, request.params);
    const retried = await run(request, tenant, async (tx, ctx) => {
      const row = await retryRun(tx, ctx, id);
      await audit(tx, request, tenant, 'automation.run.retried', { type: 'workflow_run', id });
      return row;
    });
    await app.automation.enqueue(
      'automation.run',
      { organizationId: tenant.organizationId, runId: id },
      {
        jobId: `automation-run-${id}-retry-${Date.now()}`,
        organizationId: tenant.organizationId,
        correlationId: runCorrelationId(id),
      },
    );
    return { run: await run(request, tenant, (tx, ctx) => getRun(tx, ctx, retried.id)) };
  });

  app.post('/runs/:id/cancel', async (request) => {
    const tenant = requirePermission(request, 'automation.workflow.manage');
    const { id } = parseInput(idParams, request.params);
    return {
      run: await run(request, tenant, async (tx, ctx) => {
        await cancelRun(tx, ctx, id);
        await audit(tx, request, tenant, 'automation.run.cancelled', {
          type: 'workflow_run',
          id,
        });
        return getRun(tx, ctx, id);
      }),
    };
  });
}

const tokenParams = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });
const deliveryKey = z
  .string()
  .regex(/^[A-Za-z0-9_.:-]{1,200}$/)
  .optional();

/**
 * `/webhooks/automation/:token` — starts a run of a webhook-triggered workflow with the JSON
 * body as trigger data. An `Idempotency-Key` header makes sender retries start one run.
 */
export function automationWebhookRoutes(app: FastifyInstance): void {
  app.post('/:token', { bodyLimit: 65_536 }, async (request, reply) => {
    await app.rateLimiter.consume('automationWebhookIp', request.ip);
    const params = tokenParams.safeParse(request.params);
    const target = params.success
      ? await findWorkflowByWebhookToken(app.deps.db.db, params.data.token)
      : null;
    if (!target)
      return reply.status(404).send({ error: { code: 'not_found', message: 'Not found' } });
    await app.rateLimiter.consume('automationWebhookToken', target.workflowId);
    const body: unknown = request.body;
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new ValidationError('Send a JSON object', [
        { path: 'body', message: 'Expected an object' },
      ]);
    }
    const key = parseInput(deliveryKey, request.headers['idempotency-key']);
    const result = await startRunFromWebhook(
      app.deps.db.db,
      app.automation,
      target,
      body as Record<string, unknown>,
      key ?? randomUUID(),
    );
    return reply.status(202).send({ runId: result.runId, duplicate: result.duplicate });
  });
}
