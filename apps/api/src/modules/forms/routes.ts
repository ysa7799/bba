import { recordAudit, type AuditAction } from '@businessos/audit';
import {
  listAssignees,
  listCustomFields,
  listPipelines,
  listTags,
  type CrmContext,
} from '@businessos/crm';
import { withTenant, type TenantTx } from '@businessos/database';
import {
  createForm,
  CUSTOM_TARGET_PREFIX,
  discardDraft,
  fieldTypesForCustomField,
  formListQuerySchema,
  getForm,
  getSubmission,
  listForms,
  listSubmissions,
  publishForm,
  releaseSubmission,
  saveDraft,
  setFormArchived,
  STANDARD_TARGETS,
  submissionListQuerySchema,
  updateForm,
} from '@businessos/forms';
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
const submissionParams = z.object({ id: z.uuid(), submissionId: z.uuid() });

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

/** `/app/orgs/:orgId/forms/*` — form builder, publishing and submissions. */
export function formRoutes(app: FastifyInstance): void {
  const db = () => app.deps.db.db;
  const captchaAvailable = () => ({ captchaAvailable: app.forms.captcha !== null });

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

  app.get('/', async (request) => {
    const tenant = requirePermission(request, 'forms.read');
    const query = parseInput(formListQuerySchema, request.query);
    return run(request, tenant, (tx) => listForms(tx, tenant.organizationId, query));
  });

  /** Everything the builder offers: mapping targets, tags, pipelines, members, captcha. */
  app.get('/builder-options', async (request) => {
    const tenant = requirePermission(request, 'forms.manage');
    return run(request, tenant, async (tx) => ({
      targets: [
        ...Object.entries(STANDARD_TARGETS).map(([target, fieldTypes]) => ({
          target,
          label: null,
          fieldTypes,
          options: null,
        })),
        ...(await listCustomFields(tx, tenant.organizationId, { entityType: 'contact' })).map(
          (field) => ({
            target: `${CUSTOM_TARGET_PREFIX}${field.key}`,
            label: field.label,
            fieldTypes: fieldTypesForCustomField(field.type),
            options:
              field.type === 'select' || field.type === 'multi_select' ? field.options : null,
          }),
        ),
      ],
      tags: await listTags(tx, tenant.organizationId),
      pipelines: (await listPipelines(tx, tenant.organizationId)).map((pipeline) => ({
        id: pipeline.id,
        name: pipeline.name,
        stages: pipeline.stages
          .filter((stage) => stage.kind === 'open')
          .map((stage) => ({ id: stage.id, name: stage.name })),
      })),
      members: await listAssignees(tx, tenant.organizationId),
      captcha: app.forms.captcha
        ? { status: 'CONFIGURED', provider: app.forms.captcha.provider }
        : { status: 'CONFIGURATION_REQUIRED', provider: null },
    }));
  });

  app.post('/', async (request, reply) => {
    const tenant = requirePermission(request, 'forms.manage');
    const form = await run(request, tenant, async (tx, ctx) => {
      const created = await createForm(tx, ctx, request.body as Parameters<typeof createForm>[2]);
      await audit(tx, request, tenant, 'forms.form.created', { type: 'form', id: created.id });
      return created;
    });
    return reply.status(201).send({ form });
  });

  app.get('/:id', async (request) => {
    const tenant = requirePermission(request, 'forms.read');
    const { id } = parseInput(idParams, request.params);
    return { form: await run(request, tenant, (tx) => getForm(tx, tenant.organizationId, id)) };
  });

  app.patch('/:id', async (request) => {
    const tenant = requirePermission(request, 'forms.manage');
    const { id } = parseInput(idParams, request.params);
    const form = await run(request, tenant, async (tx, ctx) => {
      const result = await updateForm(
        tx,
        ctx,
        id,
        request.body as Parameters<typeof updateForm>[3],
      );
      if (result.changedFields.length > 0) {
        await audit(
          tx,
          request,
          tenant,
          'forms.form.updated',
          { type: 'form', id },
          { changedFields: result.changedFields },
        );
      }
      return result.form;
    });
    return { form };
  });

  app.put('/:id/draft', async (request) => {
    const tenant = requirePermission(request, 'forms.manage');
    const { id } = parseInput(idParams, request.params);
    const form = await run(request, tenant, async (tx, ctx) => {
      const saved = await saveDraft(
        tx,
        ctx,
        id,
        request.body as Parameters<typeof saveDraft>[3],
        captchaAvailable(),
      );
      await audit(
        tx,
        request,
        tenant,
        'forms.form.updated',
        { type: 'form', id },
        { changedFields: ['draft'], draftVersion: saved.draft?.number ?? null },
      );
      return saved;
    });
    return { form };
  });

  app.delete('/:id/draft', async (request) => {
    const tenant = requirePermission(request, 'forms.manage');
    const { id } = parseInput(idParams, request.params);
    return { form: await run(request, tenant, (tx, ctx) => discardDraft(tx, ctx, id)) };
  });

  app.post('/:id/publish', async (request) => {
    const tenant = requirePermission(request, 'forms.manage');
    const { id } = parseInput(idParams, request.params);
    const form = await run(request, tenant, async (tx, ctx) => {
      const published = await publishForm(tx, ctx, id, captchaAvailable());
      await audit(
        tx,
        request,
        tenant,
        'forms.form.published',
        { type: 'form', id },
        { version: published.publishedVersion },
      );
      return published;
    });
    return { form };
  });

  for (const [path, archived, action] of [
    ['/:id/archive', true, 'forms.form.archived'],
    ['/:id/restore', false, 'forms.form.restored'],
  ] as const) {
    app.post(path, async (request) => {
      const tenant = requirePermission(request, 'forms.manage');
      const { id } = parseInput(idParams, request.params);
      const form = await run(request, tenant, async (tx, ctx) => {
        const changed = await setFormArchived(tx, ctx, id, archived);
        await audit(tx, request, tenant, action, { type: 'form', id });
        return changed;
      });
      return { form };
    });
  }

  app.get('/:id/submissions', async (request) => {
    const tenant = requirePermission(request, 'forms.submission.read');
    const { id } = parseInput(idParams, request.params);
    const query = parseInput(submissionListQuerySchema, request.query);
    return run(request, tenant, (tx, ctx) => listSubmissions(tx, ctx, id, query));
  });

  app.get('/:id/submissions/:submissionId', async (request) => {
    const tenant = requirePermission(request, 'forms.submission.read');
    const { id, submissionId } = parseInput(submissionParams, request.params);
    return {
      submission: await run(request, tenant, (tx, ctx) => getSubmission(tx, ctx, id, submissionId)),
    };
  });

  /** "Not spam": processes a quarantined submission into the CRM. */
  app.post('/:id/submissions/:submissionId/release', async (request) => {
    requirePermission(request, 'forms.submission.read');
    const tenant = requirePermission(request, 'forms.manage');
    const { id, submissionId } = parseInput(submissionParams, request.params);
    const submission = await run(request, tenant, async (tx, ctx) => {
      const released = await releaseSubmission(tx, ctx, id, submissionId);
      await audit(tx, request, tenant, 'forms.submission.released', {
        type: 'form_submission',
        id: submissionId,
      });
      return released;
    });
    return { submission };
  });
}
