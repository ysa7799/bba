import { activityListQuerySchema, listActivities } from '@businessos/activities';
import { recordAudit, type AuditAction } from '@businessos/audit';
import {
  addStage,
  archivePipeline,
  boardQuerySchema,
  bulkUpdateCompanies,
  bulkUpdateContacts,
  bulkUpdateDeals,
  cancelImport,
  companyBulkInputSchema,
  companyListQuerySchema,
  contactBulkInputSchema,
  contactLinkInputSchema,
  contactListQuerySchema,
  createCompany,
  createContact,
  createCustomField,
  createDeal,
  createImport,
  createNote,
  createPipeline,
  createTag,
  createTask,
  dealBoard,
  dealBulkInputSchema,
  dealListQuerySchema,
  deleteCompany,
  deleteContact,
  deleteDeal,
  deleteNote,
  deleteStage,
  deleteActivity,
  deleteTag,
  deleteTask,
  downloadExport,
  getCompany,
  getContact,
  getDeal,
  getExport,
  getImport,
  getNote,
  getTask,
  globalSearchQuerySchema,
  linkContactCompany,
  listAssignees,
  listCompanies,
  listContacts,
  listCustomFields,
  listDeals,
  listExports,
  listImports,
  listNotes,
  listPipelines,
  listTags,
  listTasks,
  logActivity,
  moveDeal,
  noteListQuerySchema,
  previewImport,
  recordTimeline,
  reorderStages,
  requestExport,
  searchCrm,
  startImport,
  taskListQuerySchema,
  unlinkContactCompany,
  updateCompany,
  updateContact,
  updateCustomField,
  updateDeal,
  updateImportMapping,
  updateNote,
  updatePipeline,
  updateStage,
  updateTag,
  updateTask,
  MAX_IMPORT_BYTES,
  type CrmContext,
  type NoteParentType,
  type PipelineDetail,
} from '@businessos/crm';
import { CUSTOM_FIELD_ENTITIES, withTenant, type TenantTx } from '@businessos/database';
import type { Permission } from '@businessos/permissions';
import { ForbiddenError, ValidationError } from '@businessos/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { auditContext } from '../../lib/http';
import { parseInput } from '../../lib/validation';
import {
  requirePermission,
  requireTenant,
  resolveTenant,
  tenantScope,
  type TenantContext,
} from '../../plugins/tenant';

const idParams = z.object({ id: z.uuid() });
const stageParams = z.object({ id: z.uuid(), stageId: z.uuid() });
const linkParams = z.object({ id: z.uuid(), companyId: z.uuid() });
const customFieldListQuery = z.object({
  entityType: z.enum(CUSTOM_FIELD_ENTITIES).optional(),
  includeArchived: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
});

const READ_PERMISSIONS = {
  contact: 'crm.contact.read',
  company: 'crm.company.read',
  deal: 'crm.deal.read',
} as const satisfies Record<NoteParentType, Permission>;

function crmContext(request: FastifyRequest, tenant: TenantContext): CrmContext {
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

/** 403 unless the member holds every listed permission. */
function requireAll(request: FastifyRequest, permissions: readonly Permission[]): TenantContext {
  const tenant = requireTenant(request);
  if (!permissions.every((permission) => tenant.permissions.has(permission)))
    throw new ForbiddenError();
  return tenant;
}

/** 403 unless the member holds at least one of the listed permissions. */
function requireAny(request: FastifyRequest, permissions: readonly Permission[]): TenantContext {
  const tenant = requireTenant(request);
  if (!permissions.some((permission) => tenant.permissions.has(permission)))
    throw new ForbiddenError();
  return tenant;
}

const ANY_CRM_READ: readonly Permission[] = [
  'crm.contact.read',
  'crm.company.read',
  'crm.deal.read',
  'crm.task.read',
];

/** `cf.<key>=value` query parameters (custom field equality filters). */
function customFieldFilters(query: unknown): Record<string, string> {
  const filters: Record<string, string> = {};
  if (query === null || typeof query !== 'object') return filters;
  for (const [key, value] of Object.entries(query)) {
    if (!key.startsWith('cf.')) continue;
    if (typeof value !== 'string' || value.length > 200) {
      throw new ValidationError('Invalid filter', [
        { path: key, message: 'Must be a single value' },
      ]);
    }
    filters[key.slice(3)] = value;
  }
  return filters;
}

/** Linking a record to another requires being able to read the linked record. */
function requireLinkReads(
  tenant: TenantContext,
  body: unknown,
  links: Partial<Record<'contactId' | 'companyId' | 'dealId', NoteParentType>>,
): void {
  if (body === null || typeof body !== 'object') return;
  for (const [field, type] of Object.entries(links)) {
    const value = (body as Record<string, unknown>)[field];
    if (typeof value === 'string' && !tenant.permissions.has(READ_PERMISSIONS[type])) {
      throw new ForbiddenError(`You cannot link records you are not allowed to see (${field})`);
    }
  }
}

export function crmRoutes(app: FastifyInstance): void {
  const db = () => app.deps.db.db;

  app.addHook('preHandler', async (request) => {
    await resolveTenant(request);
  });

  /** Runs `fn` in the tenant transaction with the CRM context of the (already authorized) caller. */
  function run<T>(
    request: FastifyRequest,
    tenant: TenantContext,
    fn: (tx: TenantTx, ctx: CrmContext) => Promise<T>,
  ): Promise<T> {
    return withTenant(db(), tenantScope(tenant), (tx) => fn(tx, crmContext(request, tenant)));
  }

  function audit(
    tx: TenantTx,
    request: FastifyRequest,
    tenant: TenantContext,
    action: AuditAction,
    target: { type: string; id: string },
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    return recordAudit(tx, auditContext(request), {
      organizationId: tenant.organizationId,
      action,
      target,
      metadata,
    });
  }

  // ── Shared ────────────────────────────────────────────────────────────────────────────────
  app.get('/assignees', async (request) => {
    const tenant = requireAny(request, ANY_CRM_READ);
    const data = await run(request, tenant, (tx) => listAssignees(tx, tenant.organizationId));
    return { data: data.map(({ userId, name }) => ({ userId, name })) };
  });

  app.get('/search', async (request) => {
    const tenant = requireAny(request, ['crm.contact.read', 'crm.company.read', 'crm.deal.read']);
    const { q } = parseInput(globalSearchQuerySchema, request.query);
    return { data: await run(request, tenant, (tx, ctx) => searchCrm(tx, ctx, q)) };
  });

  // ── Contacts ──────────────────────────────────────────────────────────────────────────────
  app.get('/contacts', async (request) => {
    const tenant = requirePermission(request, 'crm.contact.read');
    const query = parseInput(contactListQuerySchema, request.query);
    const customFields = customFieldFilters(request.query);
    return run(request, tenant, (tx, ctx) => listContacts(tx, ctx, { ...query, customFields }));
  });

  app.post('/contacts', async (request, reply) => {
    const tenant = requirePermission(request, 'crm.contact.create');
    requireLinkReads(tenant, request.body, { companyId: 'company' });
    const contact = await run(request, tenant, (tx, ctx) =>
      createContact(tx, ctx, request.body as Parameters<typeof createContact>[2]),
    );
    return reply.status(201).send({ contact });
  });

  app.get('/contacts/:id', async (request) => {
    const tenant = requirePermission(request, 'crm.contact.read');
    const { id } = parseInput(idParams, request.params);
    return { contact: await run(request, tenant, (tx, ctx) => getContact(tx, ctx, id)) };
  });

  app.patch('/contacts/:id', async (request) => {
    const tenant = requirePermission(request, 'crm.contact.update');
    const { id } = parseInput(idParams, request.params);
    const { after } = await run(request, tenant, (tx, ctx) =>
      updateContact(tx, ctx, id, request.body as Parameters<typeof updateContact>[3]),
    );
    return { contact: after };
  });

  app.delete('/contacts/:id', async (request, reply) => {
    const tenant = requirePermission(request, 'crm.contact.delete');
    const { id } = parseInput(idParams, request.params);
    await run(request, tenant, async (tx, ctx) => {
      const deleted = await deleteContact(tx, ctx, id);
      await audit(
        tx,
        request,
        tenant,
        'crm.contact.deleted',
        { type: 'contact', id },
        { name: deleted.displayName },
      );
    });
    return reply.status(204).send();
  });

  app.post('/contacts/bulk', async (request) => {
    const input = parseInput(contactBulkInputSchema, request.body);
    const tenant = requirePermission(
      request,
      input.action === 'delete' ? 'crm.contact.delete' : 'crm.contact.update',
    );
    await app.rateLimiter.consume('crmBulkOrg', tenant.organizationId);
    return run(request, tenant, async (tx, ctx) => {
      const result = await bulkUpdateContacts(tx, ctx, input);
      await audit(
        tx,
        request,
        tenant,
        'crm.bulk_action',
        { type: 'contact', id: tenant.organizationId },
        {
          entity: 'contact',
          action: input.action,
          requested: input.ids.length,
          affected: result.affected,
        },
      );
      return { affected: result.affected };
    });
  });

  app.post('/contacts/:id/companies', async (request) => {
    const tenant = requireAll(request, ['crm.contact.update', 'crm.company.read']);
    const { id } = parseInput(idParams, request.params);
    const input = parseInput(contactLinkInputSchema, request.body);
    return {
      companies: await run(request, tenant, (tx, ctx) => linkContactCompany(tx, ctx, id, input)),
    };
  });

  app.delete('/contacts/:id/companies/:companyId', async (request, reply) => {
    const tenant = requirePermission(request, 'crm.contact.update');
    const { id, companyId } = parseInput(linkParams, request.params);
    await run(request, tenant, (tx, ctx) => unlinkContactCompany(tx, ctx, id, companyId));
    return reply.status(204).send();
  });

  // ── Companies ─────────────────────────────────────────────────────────────────────────────
  app.get('/companies', async (request) => {
    const tenant = requirePermission(request, 'crm.company.read');
    const query = parseInput(companyListQuerySchema, request.query);
    const customFields = customFieldFilters(request.query);
    return run(request, tenant, (tx, ctx) => listCompanies(tx, ctx, { ...query, customFields }));
  });

  app.post('/companies', async (request, reply) => {
    const tenant = requirePermission(request, 'crm.company.create');
    const company = await run(request, tenant, (tx, ctx) =>
      createCompany(tx, ctx, request.body as Parameters<typeof createCompany>[2]),
    );
    return reply.status(201).send({ company });
  });

  app.get('/companies/:id', async (request) => {
    const tenant = requirePermission(request, 'crm.company.read');
    const { id } = parseInput(idParams, request.params);
    return { company: await run(request, tenant, (tx, ctx) => getCompany(tx, ctx, id)) };
  });

  app.patch('/companies/:id', async (request) => {
    const tenant = requirePermission(request, 'crm.company.update');
    const { id } = parseInput(idParams, request.params);
    const { after } = await run(request, tenant, (tx, ctx) =>
      updateCompany(tx, ctx, id, request.body as Parameters<typeof updateCompany>[3]),
    );
    return { company: after };
  });

  app.delete('/companies/:id', async (request, reply) => {
    const tenant = requirePermission(request, 'crm.company.delete');
    const { id } = parseInput(idParams, request.params);
    await run(request, tenant, async (tx, ctx) => {
      const deleted = await deleteCompany(tx, ctx, id);
      await audit(
        tx,
        request,
        tenant,
        'crm.company.deleted',
        { type: 'company', id },
        { name: deleted.name },
      );
    });
    return reply.status(204).send();
  });

  app.post('/companies/bulk', async (request) => {
    const input = parseInput(companyBulkInputSchema, request.body);
    const tenant = requirePermission(
      request,
      input.action === 'delete' ? 'crm.company.delete' : 'crm.company.update',
    );
    await app.rateLimiter.consume('crmBulkOrg', tenant.organizationId);
    return run(request, tenant, async (tx, ctx) => {
      const result = await bulkUpdateCompanies(tx, ctx, input);
      await audit(
        tx,
        request,
        tenant,
        'crm.bulk_action',
        { type: 'company', id: tenant.organizationId },
        {
          entity: 'company',
          action: input.action,
          requested: input.ids.length,
          affected: result.affected,
        },
      );
      return { affected: result.affected };
    });
  });

  // ── Pipelines & deals ─────────────────────────────────────────────────────────────────────
  app.get('/pipelines', async (request) => {
    const tenant = requirePermission(request, 'crm.deal.read');
    return { data: await run(request, tenant, (tx) => listPipelines(tx, tenant.organizationId)) };
  });

  app.post('/pipelines', async (request, reply) => {
    const tenant = requirePermission(request, 'crm.pipeline.manage');
    const pipeline = await run(request, tenant, async (tx) => {
      const created = await createPipeline(
        tx,
        tenant.organizationId,
        request.body as Parameters<typeof createPipeline>[2],
      );
      await audit(
        tx,
        request,
        tenant,
        'crm.pipeline.created',
        { type: 'pipeline', id: created.id },
        { name: created.name },
      );
      return created;
    });
    return reply.status(201).send({ pipeline });
  });

  app.patch('/pipelines/:id', async (request) => {
    const tenant = requirePermission(request, 'crm.pipeline.manage');
    const { id } = parseInput(idParams, request.params);
    return {
      pipeline: await run(request, tenant, async (tx) => {
        const { before, after } = await updatePipeline(
          tx,
          tenant.organizationId,
          id,
          request.body as Parameters<typeof updatePipeline>[3],
        );
        await audit(
          tx,
          request,
          tenant,
          'crm.pipeline.updated',
          { type: 'pipeline', id },
          {
            before: { name: before.name, isDefault: before.isDefault },
            after: { name: after.name, isDefault: after.isDefault },
          },
        );
        return after;
      }),
    };
  });

  app.delete('/pipelines/:id', async (request, reply) => {
    const tenant = requirePermission(request, 'crm.pipeline.manage');
    const { id } = parseInput(idParams, request.params);
    await run(request, tenant, async (tx) => {
      const archived = await archivePipeline(tx, tenant.organizationId, id);
      await audit(
        tx,
        request,
        tenant,
        'crm.pipeline.deleted',
        { type: 'pipeline', id },
        { name: archived.name },
      );
    });
    return reply.status(204).send();
  });

  const stageChange = (
    request: FastifyRequest,
    tenant: TenantContext,
    pipelineId: string,
    change: string,
    fn: (tx: TenantTx) => Promise<PipelineDetail>,
  ) =>
    run(request, tenant, async (tx) => {
      const pipeline = await fn(tx);
      await audit(
        tx,
        request,
        tenant,
        'crm.pipeline.updated',
        { type: 'pipeline', id: pipelineId },
        {
          change,
          stages: pipeline.stages.map((stage) => `${stage.name} (${stage.kind})`),
        },
      );
      return { pipeline };
    });

  app.post('/pipelines/:id/stages', async (request, reply) => {
    const tenant = requirePermission(request, 'crm.pipeline.manage');
    const { id } = parseInput(idParams, request.params);
    const result = await stageChange(request, tenant, id, 'stage_added', (tx) =>
      addStage(tx, tenant.organizationId, id, request.body as Parameters<typeof addStage>[3]),
    );
    return reply.status(201).send(result);
  });

  app.put('/pipelines/:id/stages/order', async (request) => {
    const tenant = requirePermission(request, 'crm.pipeline.manage');
    const { id } = parseInput(idParams, request.params);
    return stageChange(request, tenant, id, 'stages_reordered', (tx) =>
      reorderStages(
        tx,
        tenant.organizationId,
        id,
        request.body as Parameters<typeof reorderStages>[3],
      ),
    );
  });

  app.patch('/pipelines/:id/stages/:stageId', async (request) => {
    const tenant = requirePermission(request, 'crm.pipeline.manage');
    const { id, stageId } = parseInput(stageParams, request.params);
    return stageChange(request, tenant, id, 'stage_updated', (tx) =>
      updateStage(
        tx,
        tenant.organizationId,
        id,
        stageId,
        request.body as Parameters<typeof updateStage>[4],
      ),
    );
  });

  app.delete('/pipelines/:id/stages/:stageId', async (request) => {
    const tenant = requirePermission(request, 'crm.pipeline.manage');
    const { id, stageId } = parseInput(stageParams, request.params);
    return stageChange(request, tenant, id, 'stage_deleted', (tx) =>
      deleteStage(tx, tenant.organizationId, id, stageId),
    );
  });

  app.get('/pipelines/:id/board', async (request) => {
    const tenant = requirePermission(request, 'crm.deal.read');
    const { id } = parseInput(idParams, request.params);
    const query = parseInput(boardQuerySchema, request.query);
    return run(request, tenant, (tx, ctx) => dealBoard(tx, ctx, id, query));
  });

  app.get('/deals', async (request) => {
    const tenant = requirePermission(request, 'crm.deal.read');
    const query = parseInput(dealListQuerySchema, request.query);
    const customFields = customFieldFilters(request.query);
    return run(request, tenant, (tx, ctx) => listDeals(tx, ctx, { ...query, customFields }));
  });

  app.post('/deals', async (request, reply) => {
    const tenant = requirePermission(request, 'crm.deal.create');
    requireLinkReads(tenant, request.body, { contactId: 'contact', companyId: 'company' });
    const deal = await run(request, tenant, (tx, ctx) =>
      createDeal(tx, ctx, request.body as Parameters<typeof createDeal>[2]),
    );
    return reply.status(201).send({ deal });
  });

  app.get('/deals/:id', async (request) => {
    const tenant = requirePermission(request, 'crm.deal.read');
    const { id } = parseInput(idParams, request.params);
    return { deal: await run(request, tenant, (tx, ctx) => getDeal(tx, ctx, id)) };
  });

  app.patch('/deals/:id', async (request) => {
    const tenant = requirePermission(request, 'crm.deal.update');
    requireLinkReads(tenant, request.body, { contactId: 'contact', companyId: 'company' });
    const { id } = parseInput(idParams, request.params);
    const { after } = await run(request, tenant, (tx, ctx) =>
      updateDeal(tx, ctx, id, request.body as Parameters<typeof updateDeal>[3]),
    );
    return { deal: after };
  });

  app.post('/deals/:id/move', async (request) => {
    const tenant = requirePermission(request, 'crm.deal.update');
    const { id } = parseInput(idParams, request.params);
    const { after } = await run(request, tenant, (tx, ctx) =>
      moveDeal(tx, ctx, id, request.body as Parameters<typeof moveDeal>[3]),
    );
    return { deal: after };
  });

  app.delete('/deals/:id', async (request, reply) => {
    const tenant = requirePermission(request, 'crm.deal.delete');
    const { id } = parseInput(idParams, request.params);
    await run(request, tenant, async (tx, ctx) => {
      const deleted = await deleteDeal(tx, ctx, id);
      await audit(
        tx,
        request,
        tenant,
        'crm.deal.deleted',
        { type: 'deal', id },
        {
          name: deleted.name,
          value: deleted.value,
        },
      );
    });
    return reply.status(204).send();
  });

  app.post('/deals/bulk', async (request) => {
    const input = parseInput(dealBulkInputSchema, request.body);
    const tenant = requirePermission(
      request,
      input.action === 'delete' ? 'crm.deal.delete' : 'crm.deal.update',
    );
    await app.rateLimiter.consume('crmBulkOrg', tenant.organizationId);
    return run(request, tenant, async (tx, ctx) => {
      const result = await bulkUpdateDeals(tx, ctx, input);
      await audit(
        tx,
        request,
        tenant,
        'crm.bulk_action',
        { type: 'deal', id: tenant.organizationId },
        {
          entity: 'deal',
          action: input.action,
          requested: input.ids.length,
          affected: result.affected,
        },
      );
      return { affected: result.affected };
    });
  });

  // ── Notes (on contacts, companies and deals) ──────────────────────────────────────────────
  for (const [segment, type] of [
    ['contacts', 'contact'],
    ['companies', 'company'],
    ['deals', 'deal'],
  ] as const) {
    app.get(`/${segment}/:id/notes`, async (request) => {
      const tenant = requirePermission(request, READ_PERMISSIONS[type]);
      const { id } = parseInput(idParams, request.params);
      const query = parseInput(noteListQuerySchema, request.query);
      return run(request, tenant, (tx, ctx) => listNotes(tx, ctx, { type, id }, query));
    });

    app.post(`/${segment}/:id/notes`, async (request, reply) => {
      const tenant = requireAll(request, [READ_PERMISSIONS[type], 'crm.note.create']);
      const { id } = parseInput(idParams, request.params);
      const note = await run(request, tenant, (tx, ctx) =>
        createNote(tx, ctx, { type, id }, request.body as Parameters<typeof createNote>[3]),
      );
      return reply.status(201).send({ note });
    });
  }

  /** Loads a note and checks the caller may see its parent and change it. */
  const noteAccess = (request: FastifyRequest) => {
    const tenant = requireAny(request, ['crm.note.create', 'crm.note.manage']);
    const { id } = parseInput(idParams, request.params);
    return { tenant, id, canModerate: tenant.permissions.has('crm.note.manage') };
  };

  app.patch('/notes/:id', async (request) => {
    const { tenant, id, canModerate } = noteAccess(request);
    return {
      note: await run(request, tenant, async (tx, ctx) => {
        const note = await getNote(tx, ctx, id);
        if (!tenant.permissions.has(READ_PERMISSIONS[note.parent.type])) throw new ForbiddenError();
        return updateNote(tx, ctx, id, request.body as Parameters<typeof updateNote>[3], {
          canModerate,
        });
      }),
    };
  });

  app.delete('/notes/:id', async (request, reply) => {
    const { tenant, id, canModerate } = noteAccess(request);
    await run(request, tenant, async (tx, ctx) => {
      const note = await getNote(tx, ctx, id);
      if (!tenant.permissions.has(READ_PERMISSIONS[note.parent.type])) throw new ForbiddenError();
      await deleteNote(tx, ctx, id, { canModerate });
    });
    return reply.status(204).send();
  });

  // ── Tasks ─────────────────────────────────────────────────────────────────────────────────
  app.get('/tasks', async (request) => {
    const tenant = requirePermission(request, 'crm.task.read');
    const query = parseInput(taskListQuerySchema, request.query);
    return run(request, tenant, (tx, ctx) => listTasks(tx, ctx, query));
  });

  app.post('/tasks', async (request, reply) => {
    const tenant = requirePermission(request, 'crm.task.manage');
    requireLinkReads(tenant, request.body, {
      contactId: 'contact',
      companyId: 'company',
      dealId: 'deal',
    });
    const task = await run(request, tenant, (tx, ctx) =>
      createTask(tx, ctx, request.body as Parameters<typeof createTask>[2]),
    );
    return reply.status(201).send({ task });
  });

  app.get('/tasks/:id', async (request) => {
    const tenant = requirePermission(request, 'crm.task.read');
    const { id } = parseInput(idParams, request.params);
    return { task: await run(request, tenant, (tx, ctx) => getTask(tx, ctx, id)) };
  });

  app.patch('/tasks/:id', async (request) => {
    const tenant = requirePermission(request, 'crm.task.manage');
    requireLinkReads(tenant, request.body, {
      contactId: 'contact',
      companyId: 'company',
      dealId: 'deal',
    });
    const { id } = parseInput(idParams, request.params);
    const { after } = await run(request, tenant, (tx, ctx) =>
      updateTask(tx, ctx, id, request.body as Parameters<typeof updateTask>[3]),
    );
    return { task: after };
  });

  app.delete('/tasks/:id', async (request, reply) => {
    const tenant = requirePermission(request, 'crm.task.manage');
    const { id } = parseInput(idParams, request.params);
    await run(request, tenant, (tx, ctx) => deleteTask(tx, ctx, id));
    return reply.status(204).send();
  });

  // ── Activity timeline ────────────────────────────────────────────────────────────────────
  for (const [segment, kind] of [
    ['contacts', 'contact'],
    ['companies', 'company'],
    ['deals', 'deal'],
  ] as const) {
    app.get(`/${segment}/:id/timeline`, async (request) => {
      const tenant = requirePermission(request, READ_PERMISSIONS[kind]);
      const { id } = parseInput(idParams, request.params);
      const query = parseInput(activityListQuerySchema, request.query);
      return run(request, tenant, (tx, ctx) =>
        recordTimeline(tx, ctx, kind, id, query, tenant.permissions),
      );
    });
  }

  app.get('/activities', async (request) => {
    const tenant = requireAny(request, ANY_CRM_READ);
    const query = parseInput(activityListQuerySchema, request.query);
    return run(request, tenant, (tx) =>
      listActivities(
        tx,
        tenant.organizationId,
        { kind: 'organization' },
        query,
        tenant.permissions,
      ),
    );
  });

  app.post('/activities', async (request, reply) => {
    const tenant = requirePermission(request, 'crm.activity.log');
    requireLinkReads(tenant, request.body, {
      contactId: 'contact',
      companyId: 'company',
      dealId: 'deal',
    });
    const activity = await run(request, tenant, (tx, ctx) =>
      logActivity(tx, ctx, request.body as Parameters<typeof logActivity>[2]),
    );
    return reply.status(201).send({ activity });
  });

  app.delete('/activities/:id', async (request, reply) => {
    const tenant = requireAny(request, ['crm.activity.log', 'crm.activity.manage']);
    const { id } = parseInput(idParams, request.params);
    await run(request, tenant, async (tx, ctx) => {
      const deleted = await deleteActivity(tx, ctx, id, {
        permissions: tenant.permissions,
        canModerate: tenant.permissions.has('crm.activity.manage'),
      });
      await audit(
        tx,
        request,
        tenant,
        'crm.activity.deleted',
        { type: 'activity', id },
        {
          type: deleted.type,
          summary: deleted.summary,
        },
      );
    });
    return reply.status(204).send();
  });

  // ── Tags ──────────────────────────────────────────────────────────────────────────────────
  app.get('/tags', async (request) => {
    const tenant = requireAny(request, ANY_CRM_READ);
    return { data: await run(request, tenant, (tx) => listTags(tx, tenant.organizationId)) };
  });

  app.post('/tags', async (request, reply) => {
    const tenant = requirePermission(request, 'crm.tag.manage');
    const tag = await run(request, tenant, (tx) =>
      createTag(tx, tenant.organizationId, request.body as Parameters<typeof createTag>[2]),
    );
    return reply.status(201).send({ tag });
  });

  app.patch('/tags/:id', async (request) => {
    const tenant = requirePermission(request, 'crm.tag.manage');
    const { id } = parseInput(idParams, request.params);
    return {
      tag: await run(request, tenant, (tx) =>
        updateTag(tx, tenant.organizationId, id, request.body as Parameters<typeof updateTag>[3]),
      ),
    };
  });

  app.delete('/tags/:id', async (request, reply) => {
    const tenant = requirePermission(request, 'crm.tag.manage');
    const { id } = parseInput(idParams, request.params);
    await run(request, tenant, async (tx) => {
      const tag = await deleteTag(tx, tenant.organizationId, id);
      await audit(tx, request, tenant, 'crm.tag.deleted', { type: 'tag', id }, { name: tag.name });
    });
    return reply.status(204).send();
  });

  // ── Custom fields ─────────────────────────────────────────────────────────────────────────
  app.get('/custom-fields', async (request) => {
    const tenant = requireAny(request, ANY_CRM_READ);
    const query = parseInput(customFieldListQuery, request.query);
    if (query.includeArchived && !tenant.permissions.has('crm.custom_field.manage'))
      throw new ForbiddenError();
    return {
      data: await run(request, tenant, (tx) => listCustomFields(tx, tenant.organizationId, query)),
    };
  });

  app.post('/custom-fields', async (request, reply) => {
    const tenant = requirePermission(request, 'crm.custom_field.manage');
    const field = await run(request, tenant, async (tx) => {
      const created = await createCustomField(
        tx,
        tenant.organizationId,
        request.body as Parameters<typeof createCustomField>[2],
      );
      await audit(
        tx,
        request,
        tenant,
        'crm.custom_field.created',
        { type: 'custom_field', id: created.id },
        {
          entityType: created.entityType,
          key: created.key,
          type: created.type,
        },
      );
      return created;
    });
    return reply.status(201).send({ field });
  });

  app.patch('/custom-fields/:id', async (request) => {
    const tenant = requirePermission(request, 'crm.custom_field.manage');
    const { id } = parseInput(idParams, request.params);
    return {
      field: await run(request, tenant, async (tx) => {
        const { before, after } = await updateCustomField(
          tx,
          tenant.organizationId,
          id,
          request.body as Parameters<typeof updateCustomField>[3],
        );
        const archivedNow = !before.archived && after.archived;
        await audit(
          tx,
          request,
          tenant,
          archivedNow ? 'crm.custom_field.archived' : 'crm.custom_field.updated',
          { type: 'custom_field', id },
          {
            key: after.key,
            label: after.label,
            required: after.required,
            archived: after.archived,
          },
        );
        return after;
      }),
    };
  });

  // ── Import ────────────────────────────────────────────────────────────────────────────────
  const importPermissions = (entityType: 'contact' | 'company'): Permission[] =>
    entityType === 'contact'
      ? ['crm.data.import', 'crm.contact.create', 'crm.contact.update']
      : ['crm.data.import', 'crm.company.create', 'crm.company.update'];

  app.get('/imports', async (request) => {
    const tenant = requirePermission(request, 'crm.data.import');
    return { data: await run(request, tenant, (tx) => listImports(tx, tenant.organizationId)) };
  });

  app.post('/imports', { bodyLimit: MAX_IMPORT_BYTES * 2 + 64 * 1024 }, async (request, reply) => {
    const body = parseInput(
      z.object({ entityType: z.enum(['contact', 'company']) }).loose(),
      request.body,
    );
    const tenant = requireAll(request, importPermissions(body.entityType));
    await app.rateLimiter.consume('crmImportOrg', tenant.organizationId);
    const created = await run(request, tenant, (tx, ctx) =>
      createImport(tx, ctx, request.body as Parameters<typeof createImport>[2]),
    );
    return reply.status(201).send({ import: created });
  });

  async function loadImport(request: FastifyRequest) {
    const tenant = requirePermission(request, 'crm.data.import');
    const { id } = parseInput(idParams, request.params);
    const detail = await run(request, tenant, (tx) => getImport(tx, tenant.organizationId, id));
    requireAll(request, importPermissions(detail.entityType));
    return { tenant, id, detail };
  }

  app.get('/imports/:id', async (request) => {
    const { detail } = await loadImport(request);
    return { import: detail };
  });

  app.patch('/imports/:id', async (request) => {
    const { tenant, id } = await loadImport(request);
    return {
      import: await run(request, tenant, (tx, ctx) =>
        updateImportMapping(tx, ctx, id, request.body as Parameters<typeof updateImportMapping>[3]),
      ),
    };
  });

  app.get('/imports/:id/preview', async (request) => {
    const { tenant, id } = await loadImport(request);
    return { data: await run(request, tenant, (tx, ctx) => previewImport(tx, ctx, id)) };
  });

  app.post('/imports/:id/start', async (request) => {
    const { tenant, id } = await loadImport(request);
    const started = await run(request, tenant, async (tx, ctx) => {
      const detail = await startImport(tx, ctx, id);
      await audit(
        tx,
        request,
        tenant,
        'crm.import.started',
        { type: 'crm_import', id },
        {
          entityType: detail.entityType,
          fileName: detail.fileName,
          rows: detail.totalRows,
          duplicatePolicy: detail.duplicatePolicy,
        },
      );
      return detail;
    });
    // Enqueued after commit; the deterministic job id makes retries of this call safe.
    await app.deps.jobs.enqueue(
      'crm.import',
      { organizationId: tenant.organizationId, importId: id },
      {
        jobId: `crm-import-${id}`,
        correlationId: request.id,
        organizationId: tenant.organizationId,
      },
    );
    return { import: started };
  });

  app.post('/imports/:id/cancel', async (request) => {
    const { tenant, id } = await loadImport(request);
    return { import: await run(request, tenant, (tx, ctx) => cancelImport(tx, ctx, id)) };
  });

  // ── Export ────────────────────────────────────────────────────────────────────────────────
  const exportReadPermission = (entityType: 'contact' | 'company' | 'deal'): Permission =>
    READ_PERMISSIONS[entityType];

  app.get('/exports', async (request) => {
    const tenant = requirePermission(request, 'crm.data.export');
    return { data: await run(request, tenant, (tx, ctx) => listExports(tx, ctx)) };
  });

  app.post('/exports', async (request, reply) => {
    const body = parseInput(
      z.object({ entityType: z.enum(['contact', 'company', 'deal']) }).loose(),
      request.body,
    );
    const tenant = requireAll(request, ['crm.data.export', exportReadPermission(body.entityType)]);
    await app.rateLimiter.consume('crmExportOrg', tenant.organizationId);
    const requested = await run(request, tenant, async (tx, ctx) => {
      const created = await requestExport(
        tx,
        ctx,
        request.body as Parameters<typeof requestExport>[2],
      );
      await audit(
        tx,
        request,
        tenant,
        'crm.export.requested',
        { type: 'crm_export', id: created.id },
        {
          entityType: created.entityType,
          filters: (request.body as { filters?: unknown }).filters ?? {},
        },
      );
      return created;
    });
    await app.deps.jobs.enqueue(
      'crm.export',
      { organizationId: tenant.organizationId, exportId: requested.id },
      {
        jobId: `crm-export-${requested.id}`,
        correlationId: request.id,
        organizationId: tenant.organizationId,
      },
    );
    return reply.status(202).send({ export: requested });
  });

  app.get('/exports/:id', async (request) => {
    const tenant = requirePermission(request, 'crm.data.export');
    const { id } = parseInput(idParams, request.params);
    return { export: await run(request, tenant, (tx, ctx) => getExport(tx, ctx, id)) };
  });

  app.get('/exports/:id/download', async (request, reply) => {
    const tenant = requirePermission(request, 'crm.data.export');
    const { id } = parseInput(idParams, request.params);
    const file = await run(request, tenant, async (tx, ctx) => {
      const result = await downloadExport(tx, ctx, id);
      // Re-check read access at download time: permissions may have changed since the request.
      if (!tenant.permissions.has(exportReadPermission(result.summary.entityType)))
        throw new ForbiddenError();
      await audit(
        tx,
        request,
        tenant,
        'crm.export.downloaded',
        { type: 'crm_export', id },
        {
          entityType: result.summary.entityType,
          rows: result.summary.rowCount,
        },
      );
      return result;
    });
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${file.fileName}"`)
      .header('cache-control', 'no-store')
      .send(file.content);
  });
}
