import {
  beginIdempotentRequest,
  completeIdempotentRequest,
  parseIdempotencyKey,
  releaseIdempotentRequest,
  requestFingerprint,
  type ApiScope,
} from '@businessos/api-keys';
import { recordAudit } from '@businessos/audit';
import { getInvoice, invoiceListQuerySchema, listInvoices } from '@businessos/commerce';
import {
  companyListQuerySchema,
  contactListQuerySchema,
  createCompany,
  createContact,
  createDeal,
  createTask,
  dealListQuerySchema,
  deleteCompany,
  deleteContact,
  deleteDeal,
  deleteTask,
  getCompany,
  getContact,
  getDeal,
  getTask,
  listCompanies,
  listContacts,
  listDeals,
  listTasks,
  moveDeal,
  taskListQuerySchema,
  updateCompany,
  updateContact,
  updateDeal,
  updateTask,
  type CrmContext,
} from '@businessos/crm';
import { withTenant, type TenantTx } from '@businessos/database';
import { ForbiddenError, ValidationError } from '@businessos/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { parseInput } from '../../lib/validation';
import {
  apiAuditContext,
  requireApiCaller,
  requireScope,
  resolveApiCaller,
  type ApiCallerContext,
} from '../../plugins/api-key';

const idParams = z.object({ id: z.uuid() });

const READ_SCOPES = {
  contact: 'crm.contact.read',
  company: 'crm.company.read',
  deal: 'crm.deal.read',
} as const satisfies Record<string, ApiScope>;

function crmContext(request: FastifyRequest, caller: ApiCallerContext): CrmContext {
  return {
    organizationId: caller.organizationId,
    countryCode: caller.organization.countryCode,
    defaultCurrency: caller.organization.defaultCurrency,
    timezone: caller.organization.timezone,
    actor: { type: 'api_key', userId: null, apiKeyId: caller.apiKeyId, correlationId: request.id },
    canRead: {
      contact: caller.scopes.has('crm.contact.read'),
      company: caller.scopes.has('crm.company.read'),
      deal: caller.scopes.has('crm.deal.read'),
    },
  };
}

/** Linking to a record requires being allowed to read that kind of record. */
function requireLinkReads(
  caller: ApiCallerContext,
  body: unknown,
  links: Partial<Record<'contactId' | 'companyId' | 'dealId', keyof typeof READ_SCOPES>>,
): void {
  if (body === null || typeof body !== 'object') return;
  for (const [field, type] of Object.entries(links)) {
    const value = (body as Record<string, unknown>)[field];
    if (typeof value === 'string' && !caller.scopes.has(READ_SCOPES[type])) {
      throw new ForbiddenError(`Linking ${field} needs the ${READ_SCOPES[type]} scope`);
    }
  }
}

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

/**
 * `/api/v1` — the public API, authenticated by API key only. Every operation requires the
 * scope named after the permission it stands for; the organization always comes from the key.
 */
export function publicApiRoutes(app: FastifyInstance): void {
  const db = () => app.deps.db.db;

  // Before the body is read: unauthenticated requests are refused without parsing anything.
  app.addHook('onRequest', async (request) => {
    await resolveApiCaller(app, request);
  });

  function run<T>(
    request: FastifyRequest,
    caller: ApiCallerContext,
    fn: (tx: TenantTx, ctx: CrmContext) => Promise<T>,
  ): Promise<T> {
    return withTenant(db(), { organizationId: caller.organizationId, userId: null }, (tx) =>
      fn(tx, crmContext(request, caller)),
    );
  }

  /**
   * Creates honour `Idempotency-Key`: the first successful result is stored and replayed for
   * 24 hours to retries with the same key; the same key with another request is refused.
   */
  async function created(
    request: FastifyRequest,
    reply: FastifyReply,
    caller: ApiCallerContext,
    handler: () => Promise<unknown>,
  ) {
    const key = parseIdempotencyKey(request.headers['idempotency-key']);
    if (!key) return reply.status(201).send(await handler());
    const scope = { organizationId: caller.organizationId, apiKeyId: caller.apiKeyId };
    const start = await beginIdempotentRequest(
      db(),
      scope,
      key,
      requestFingerprint(request.method, request.url, request.body),
    );
    if (start.kind === 'replay') {
      return reply.status(start.status).header('idempotent-replayed', 'true').send(start.body);
    }
    try {
      const body = await handler();
      await completeIdempotentRequest(db(), scope, start.id, 201, body);
      return await reply.status(201).send(body);
    } catch (error) {
      await releaseIdempotentRequest(db(), scope, start.id);
      throw error;
    }
  }

  app.get('/me', (request) => {
    const caller = requireApiCaller(request);
    return {
      apiKey: {
        id: caller.apiKeyId,
        name: caller.name,
        prefix: caller.prefix,
        scopes: [...caller.scopes],
      },
      organization: {
        id: caller.organization.id,
        name: caller.organization.name,
        defaultCurrency: caller.organization.defaultCurrency,
        timezone: caller.organization.timezone,
        countryCode: caller.organization.countryCode,
      },
    };
  });

  // ── Contacts ──────────────────────────────────────────────────────────────────────────────
  app.get('/contacts', async (request) => {
    const caller = requireScope(request, 'crm.contact.read');
    const query = parseInput(contactListQuerySchema, request.query);
    const customFields = customFieldFilters(request.query);
    return run(request, caller, (tx, ctx) => listContacts(tx, ctx, { ...query, customFields }));
  });

  app.post('/contacts', async (request, reply) => {
    const caller = requireScope(request, 'crm.contact.create');
    requireLinkReads(caller, request.body, { companyId: 'company' });
    return created(request, reply, caller, async () => ({
      contact: await run(request, caller, (tx, ctx) =>
        createContact(tx, ctx, request.body as Parameters<typeof createContact>[2]),
      ),
    }));
  });

  app.get('/contacts/:id', async (request) => {
    const caller = requireScope(request, 'crm.contact.read');
    const { id } = parseInput(idParams, request.params);
    return { contact: await run(request, caller, (tx, ctx) => getContact(tx, ctx, id)) };
  });

  app.patch('/contacts/:id', async (request) => {
    const caller = requireScope(request, 'crm.contact.update');
    requireLinkReads(caller, request.body, { companyId: 'company' });
    const { id } = parseInput(idParams, request.params);
    const { after } = await run(request, caller, (tx, ctx) =>
      updateContact(tx, ctx, id, request.body as Parameters<typeof updateContact>[3]),
    );
    return { contact: after };
  });

  app.delete('/contacts/:id', async (request, reply) => {
    const caller = requireScope(request, 'crm.contact.delete');
    const { id } = parseInput(idParams, request.params);
    await run(request, caller, async (tx, ctx) => {
      const deleted = await deleteContact(tx, ctx, id);
      await recordAudit(tx, apiAuditContext(request), {
        organizationId: caller.organizationId,
        action: 'crm.contact.deleted',
        target: { type: 'contact', id },
        metadata: { name: deleted.displayName },
      });
    });
    return reply.status(204).send();
  });

  // ── Companies ─────────────────────────────────────────────────────────────────────────────
  app.get('/companies', async (request) => {
    const caller = requireScope(request, 'crm.company.read');
    const query = parseInput(companyListQuerySchema, request.query);
    const customFields = customFieldFilters(request.query);
    return run(request, caller, (tx, ctx) => listCompanies(tx, ctx, { ...query, customFields }));
  });

  app.post('/companies', async (request, reply) => {
    const caller = requireScope(request, 'crm.company.create');
    return created(request, reply, caller, async () => ({
      company: await run(request, caller, (tx, ctx) =>
        createCompany(tx, ctx, request.body as Parameters<typeof createCompany>[2]),
      ),
    }));
  });

  app.get('/companies/:id', async (request) => {
    const caller = requireScope(request, 'crm.company.read');
    const { id } = parseInput(idParams, request.params);
    return { company: await run(request, caller, (tx, ctx) => getCompany(tx, ctx, id)) };
  });

  app.patch('/companies/:id', async (request) => {
    const caller = requireScope(request, 'crm.company.update');
    const { id } = parseInput(idParams, request.params);
    const { after } = await run(request, caller, (tx, ctx) =>
      updateCompany(tx, ctx, id, request.body as Parameters<typeof updateCompany>[3]),
    );
    return { company: after };
  });

  app.delete('/companies/:id', async (request, reply) => {
    const caller = requireScope(request, 'crm.company.delete');
    const { id } = parseInput(idParams, request.params);
    await run(request, caller, async (tx, ctx) => {
      const deleted = await deleteCompany(tx, ctx, id);
      await recordAudit(tx, apiAuditContext(request), {
        organizationId: caller.organizationId,
        action: 'crm.company.deleted',
        target: { type: 'company', id },
        metadata: { name: deleted.name },
      });
    });
    return reply.status(204).send();
  });

  // ── Deals ─────────────────────────────────────────────────────────────────────────────────
  app.get('/deals', async (request) => {
    const caller = requireScope(request, 'crm.deal.read');
    const query = parseInput(dealListQuerySchema, request.query);
    const customFields = customFieldFilters(request.query);
    return run(request, caller, (tx, ctx) => listDeals(tx, ctx, { ...query, customFields }));
  });

  app.post('/deals', async (request, reply) => {
    const caller = requireScope(request, 'crm.deal.create');
    requireLinkReads(caller, request.body, { contactId: 'contact', companyId: 'company' });
    return created(request, reply, caller, async () => ({
      deal: await run(request, caller, (tx, ctx) =>
        createDeal(tx, ctx, request.body as Parameters<typeof createDeal>[2]),
      ),
    }));
  });

  app.get('/deals/:id', async (request) => {
    const caller = requireScope(request, 'crm.deal.read');
    const { id } = parseInput(idParams, request.params);
    return { deal: await run(request, caller, (tx, ctx) => getDeal(tx, ctx, id)) };
  });

  app.patch('/deals/:id', async (request) => {
    const caller = requireScope(request, 'crm.deal.update');
    requireLinkReads(caller, request.body, { contactId: 'contact', companyId: 'company' });
    const { id } = parseInput(idParams, request.params);
    const { after } = await run(request, caller, (tx, ctx) =>
      updateDeal(tx, ctx, id, request.body as Parameters<typeof updateDeal>[3]),
    );
    return { deal: after };
  });

  app.post('/deals/:id/move', async (request) => {
    const caller = requireScope(request, 'crm.deal.update');
    const { id } = parseInput(idParams, request.params);
    const { after } = await run(request, caller, (tx, ctx) =>
      moveDeal(tx, ctx, id, request.body as Parameters<typeof moveDeal>[3]),
    );
    return { deal: after };
  });

  app.delete('/deals/:id', async (request, reply) => {
    const caller = requireScope(request, 'crm.deal.delete');
    const { id } = parseInput(idParams, request.params);
    await run(request, caller, async (tx, ctx) => {
      const deleted = await deleteDeal(tx, ctx, id);
      await recordAudit(tx, apiAuditContext(request), {
        organizationId: caller.organizationId,
        action: 'crm.deal.deleted',
        target: { type: 'deal', id },
        metadata: { name: deleted.name, value: deleted.value },
      });
    });
    return reply.status(204).send();
  });

  // ── Tasks ─────────────────────────────────────────────────────────────────────────────────
  const taskLinks = { contactId: 'contact', companyId: 'company', dealId: 'deal' } as const;

  app.get('/tasks', async (request) => {
    const caller = requireScope(request, 'crm.task.read');
    const query = parseInput(taskListQuerySchema, request.query);
    return run(request, caller, (tx, ctx) => listTasks(tx, ctx, query));
  });

  app.post('/tasks', async (request, reply) => {
    const caller = requireScope(request, 'crm.task.manage');
    requireLinkReads(caller, request.body, taskLinks);
    return created(request, reply, caller, async () => ({
      task: await run(request, caller, (tx, ctx) =>
        createTask(tx, ctx, request.body as Parameters<typeof createTask>[2]),
      ),
    }));
  });

  app.get('/tasks/:id', async (request) => {
    const caller = requireScope(request, 'crm.task.read');
    const { id } = parseInput(idParams, request.params);
    return { task: await run(request, caller, (tx, ctx) => getTask(tx, ctx, id)) };
  });

  app.patch('/tasks/:id', async (request) => {
    const caller = requireScope(request, 'crm.task.manage');
    requireLinkReads(caller, request.body, taskLinks);
    const { id } = parseInput(idParams, request.params);
    const { after } = await run(request, caller, (tx, ctx) =>
      updateTask(tx, ctx, id, request.body as Parameters<typeof updateTask>[3]),
    );
    return { task: after };
  });

  app.delete('/tasks/:id', async (request, reply) => {
    const caller = requireScope(request, 'crm.task.manage');
    const { id } = parseInput(idParams, request.params);
    await run(request, caller, (tx, ctx) => deleteTask(tx, ctx, id));
    return reply.status(204).send();
  });

  // ── Invoices (read only) ──────────────────────────────────────────────────────────────────
  app.get('/invoices', async (request) => {
    const caller = requireScope(request, 'commerce.invoice.read');
    const query = parseInput(invoiceListQuerySchema, request.query);
    return run(request, caller, (tx, ctx) => listInvoices(tx, ctx, query));
  });

  app.get('/invoices/:id', async (request) => {
    const caller = requireScope(request, 'commerce.invoice.read');
    const { id } = parseInput(idParams, request.params);
    return { invoice: await run(request, caller, (tx, ctx) => getInvoice(tx, ctx, id)) };
  });
}
