import { recordAudit, type AuditAction } from '@businessos/audit';
import {
  assignConversation,
  createConnection,
  disconnectConnection,
  FakeChannelProvider,
  getConnectionRow,
  getConversation,
  handleChannelWebhook,
  handleWebhookVerification,
  listConnections,
  listConversations,
  listMessages,
  listTemplates,
  markConversationRead,
  messageListQuerySchema,
  addInternalNote,
  conversationListQuerySchema,
  queueMessage,
  registerTemplate,
  resolveConnection,
  rotateWebhookToken,
  setConversationStatus,
  setConversationTags,
  startConversation,
  unreadConversationCount,
  updateConnection,
  type ConnectionSummary,
} from '@businessos/communications';
import type { CrmContext } from '@businessos/crm';
import { messages, withTenant, type Message, type TenantTx } from '@businessos/database';
import { ForbiddenError, newId, NotFoundError, ValidationError } from '@businessos/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
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
const patchConversationSchema = z.object({
  assigneeUserId: z.uuid().nullable().optional(),
  status: z.enum(['open', 'closed']).optional(),
  tagIds: z.array(z.uuid()).max(50).optional(),
});

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

function toMessageResponse(message: Message) {
  return {
    id: message.id,
    direction: message.direction,
    status: message.status,
    subject: message.subject,
    text: message.bodyText,
    template: message.template,
    createdAt: message.createdAt.toISOString(),
  };
}

/** What members without `communications.manage` may see about a channel. */
function publicChannel(connection: ConnectionSummary) {
  return {
    id: connection.id,
    channel: connection.channel,
    provider: connection.provider,
    providerLabel: connection.providerLabel,
    name: connection.name,
    address: connection.address,
    status: connection.status,
  };
}

/** `/app/orgs/:orgId/communications/*` — shared inbox and channel management. */
export function communicationsRoutes(app: FastifyInstance): void {
  const db = () => app.deps.db.db;

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
    id: string,
    metadata?: Record<string, unknown>,
  ) {
    return recordAudit(tx, auditContext(request), {
      organizationId: tenant.organizationId,
      action,
      target: { type: 'channel_connection', id },
      metadata,
    });
  }

  // ── Inbox ─────────────────────────────────────────────────────────────────────────────────
  app.get('/conversations', async (request) => {
    const tenant = requirePermission(request, 'communications.read');
    const query = parseInput(conversationListQuerySchema, request.query);
    return run(request, tenant, (tx, ctx) => listConversations(tx, ctx, query));
  });

  app.get('/conversations/unread-count', async (request) => {
    const tenant = requirePermission(request, 'communications.read');
    return {
      unread: await run(request, tenant, (tx) =>
        unreadConversationCount(tx, tenant.organizationId),
      ),
    };
  });

  app.get('/conversations/:id', async (request) => {
    const tenant = requirePermission(request, 'communications.read');
    const { id } = parseInput(idParams, request.params);
    return { conversation: await run(request, tenant, (tx, ctx) => getConversation(tx, ctx, id)) };
  });

  app.get('/conversations/:id/messages', async (request) => {
    const tenant = requirePermission(request, 'communications.read');
    const { id } = parseInput(idParams, request.params);
    const query = parseInput(messageListQuerySchema, request.query);
    return run(request, tenant, (tx, ctx) => listMessages(tx, ctx, id, query));
  });

  app.post('/conversations/:id/read', async (request, reply) => {
    const tenant = requirePermission(request, 'communications.read');
    const { id } = parseInput(idParams, request.params);
    await run(request, tenant, (tx, ctx) => markConversationRead(tx, ctx, id));
    return reply.status(204).send();
  });

  app.post('/conversations', async (request, reply) => {
    const tenant = requirePermission(request, 'communications.send');
    if (!tenant.permissions.has('crm.contact.read')) throw new ForbiddenError();
    const result = await run(request, tenant, (tx, ctx) =>
      startConversation(tx, ctx, request.body as Parameters<typeof startConversation>[2]),
    );
    return reply.status(result.created ? 201 : 200).send({ conversation: result.conversation });
  });

  app.post('/conversations/:id/messages', async (request, reply) => {
    const tenant = requirePermission(request, 'communications.send');
    const { id } = parseInput(idParams, request.params);
    const message = await run(request, tenant, (tx, ctx) =>
      queueMessage(tx, ctx, id, request.body as Parameters<typeof queueMessage>[3]),
    );
    // Enqueued after commit; the deterministic id makes a retried request harmless.
    await app.deps.jobs.enqueue(
      'communications.send',
      { organizationId: tenant.organizationId, messageId: message.id },
      {
        jobId: `msg-${message.id}`,
        correlationId: request.id,
        organizationId: tenant.organizationId,
      },
    );
    return reply.status(202).send({ message: toMessageResponse(message) });
  });

  app.post('/conversations/:id/notes', async (request, reply) => {
    const tenant = requirePermission(request, 'communications.send');
    const { id } = parseInput(idParams, request.params);
    const note = await run(request, tenant, (tx, ctx) =>
      addInternalNote(tx, ctx, id, request.body as Parameters<typeof addInternalNote>[3]),
    );
    return reply.status(201).send({ message: toMessageResponse(note) });
  });

  app.patch('/conversations/:id', async (request) => {
    const tenant = requirePermission(request, 'communications.assign');
    const { id } = parseInput(idParams, request.params);
    const input = parseInput(patchConversationSchema, request.body);
    return {
      conversation: await run(request, tenant, async (tx, ctx) => {
        if (input.assigneeUserId !== undefined)
          await assignConversation(tx, ctx, id, input.assigneeUserId);
        if (input.status !== undefined) await setConversationStatus(tx, ctx, id, input.status);
        if (input.tagIds !== undefined) await setConversationTags(tx, ctx, id, input.tagIds);
        return getConversation(tx, ctx, id);
      }),
    };
  });

  app.get('/templates', async (request) => {
    const tenant = requirePermission(request, 'communications.read');
    const { connectionId } = parseInput(
      z.object({ connectionId: z.uuid().optional() }),
      request.query,
    );
    return {
      data: await run(request, tenant, (tx) =>
        listTemplates(tx, tenant.organizationId, connectionId),
      ),
    };
  });

  // ── Channels ──────────────────────────────────────────────────────────────────────────────
  app.get('/channels', async (request) => {
    const tenant = requirePermission(request, 'communications.read');
    const connections = await run(request, tenant, (tx) =>
      listConnections(tx, tenant.organizationId, app.communications),
    );
    return {
      data: tenant.permissions.has('communications.manage')
        ? connections
        : connections.map(publicChannel),
    };
  });

  app.get('/channels/providers', (request) => {
    requirePermission(request, 'communications.manage');
    return {
      encryptionConfigured: app.communications.secretBox !== null,
      data: app.communications.providers.list().map((provider) => ({
        key: provider.key,
        channel: provider.channel,
        label: provider.label,
        requiresExternalAccountId: provider.requiresExternalAccountId,
        credentialFields: provider.credentialFields,
      })),
    };
  });

  app.post('/channels', async (request, reply) => {
    const tenant = requirePermission(request, 'communications.manage');
    const result = await run(request, tenant, async (tx, ctx) => {
      const created = await createConnection(
        tx,
        ctx,
        app.communications,
        request.body as Parameters<typeof createConnection>[3],
      );
      await audit(tx, request, tenant, 'communications.channel.connected', created.connection.id, {
        channel: created.connection.channel,
        provider: created.connection.provider,
        address: created.connection.address,
        configuredFields: created.connection.configuredFields,
      });
      return created;
    });
    return reply.status(201).send(result);
  });

  app.patch('/channels/:id', async (request) => {
    const tenant = requirePermission(request, 'communications.manage');
    const { id } = parseInput(idParams, request.params);
    const body = request.body as Parameters<typeof updateConnection>[4];
    return {
      connection: await run(request, tenant, async (tx) => {
        const updated = await updateConnection(
          tx,
          tenant.organizationId,
          app.communications,
          id,
          body,
        );
        await audit(tx, request, tenant, 'communications.channel.updated', id, {
          name: updated.name,
          // Which credential fields were replaced — never their values.
          credentialFieldsReplaced:
            body.credentials && typeof body.credentials === 'object'
              ? Object.keys(body.credentials)
              : [],
        });
        return updated;
      }),
    };
  });

  app.post('/channels/:id/rotate-webhook', async (request) => {
    const tenant = requirePermission(request, 'communications.manage');
    const { id } = parseInput(idParams, request.params);
    return run(request, tenant, async (tx) => {
      const result = await rotateWebhookToken(tx, tenant.organizationId, app.communications, id);
      await audit(tx, request, tenant, 'communications.channel.webhook_rotated', id);
      return result;
    });
  });

  app.delete('/channels/:id', async (request, reply) => {
    const tenant = requirePermission(request, 'communications.manage');
    const { id } = parseInput(idParams, request.params);
    await run(request, tenant, async (tx) => {
      const disconnected = await disconnectConnection(
        tx,
        tenant.organizationId,
        app.communications,
        id,
      );
      await audit(tx, request, tenant, 'communications.channel.disconnected', id, {
        name: disconnected.name,
      });
    });
    return reply.status(204).send();
  });

  app.post('/channels/:id/templates', async (request, reply) => {
    const tenant = requirePermission(request, 'communications.manage');
    const { id } = parseInput(idParams, request.params);
    const template = await run(request, tenant, async (tx) => {
      const created = await registerTemplate(
        tx,
        tenant.organizationId,
        id,
        request.body as Parameters<typeof registerTemplate>[3],
      );
      await audit(tx, request, tenant, 'communications.template.registered', id, {
        name: created?.name,
        language: created?.language,
      });
      return created;
    });
    return reply.status(201).send({ template });
  });
}

function sendOutcome(
  reply: FastifyReply,
  outcome: Awaited<ReturnType<typeof handleChannelWebhook>>,
) {
  switch (outcome.status) {
    case 'not_found':
      return reply.status(404).send({
        error: { code: 'not_found', message: 'Unknown webhook', requestId: reply.request.id },
      });
    case 'invalid_signature':
      return reply.status(401).send({
        error: {
          code: 'unauthenticated',
          message: 'Invalid webhook signature',
          requestId: reply.request.id,
        },
      });
    case 'challenge':
      return reply.type('text/plain').send(outcome.challenge);
    case 'processed':
      return reply.send({ received: true });
  }
}

/**
 * `/webhooks/communications/:provider/:token` — provider callbacks. The raw body is kept for
 * signature verification; the token in the path selects the connection (and so the tenant).
 */
export function communicationWebhookRoutes(app: FastifyInstance): void {
  app.removeAllContentTypeParsers();
  app.addContentTypeParser(
    '*',
    { parseAs: 'buffer', bodyLimit: 10 * 1024 * 1024 },
    (_request, body, done) => {
      done(null, body);
    },
  );
  const params = z.object({
    provider: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/),
    token: z.string().regex(/^[A-Za-z0-9_-]{20,100}$/),
  });

  app.post(
    '/:provider/:token',
    { config: { rateLimit: { max: 1_200, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const parsed = params.safeParse(request.params);
      if (!parsed.success) return sendOutcome(reply, { status: 'not_found' });
      const outcome = await handleChannelWebhook(
        app.deps.db.db,
        app.communications,
        parsed.data.provider,
        parsed.data.token,
        {
          rawBody: Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0),
          headers: request.headers,
          url: `${app.deps.env.API_PUBLIC_URL.replace(/\/$/, '')}${request.url}`,
          query: request.query as Record<string, string | undefined>,
        },
      );
      return sendOutcome(reply, outcome);
    },
  );

  app.get(
    '/:provider/:token',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const parsed = params.safeParse(request.params);
      if (!parsed.success) return sendOutcome(reply, { status: 'not_found' });
      const outcome = await handleWebhookVerification(
        app.deps.db.db,
        app.communications,
        parsed.data.provider,
        parsed.data.token,
        request.query as Record<string, string | undefined>,
      );
      return sendOutcome(
        reply,
        outcome.status === 'invalid_signature' ? { status: 'not_found' } : outcome,
      );
    },
  );
}

const simulateInboundSchema = z.object({
  from: z.string().trim().min(1).max(320),
  fromName: z.string().trim().max(200).optional(),
  subject: z.string().trim().max(300).optional(),
  text: z.string().max(10_000),
});
const simulateStatusSchema = z.object({
  messageId: z.uuid(),
  status: z.enum(['delivered', 'read', 'failed']),
});

/**
 * Development only (fake providers enabled, never production): simulate a customer writing in
 * or a delivery receipt. Payloads are signed with the connection's own secret and go through
 * the real webhook pipeline.
 */
export function devCommunicationRoutes(app: FastifyInstance): void {
  app.addHook('preHandler', async (request) => {
    await resolveTenant(request);
  });

  /** The fake connection (manage permission), its signing secret and its webhook token. */
  async function fakeConnection(request: FastifyRequest) {
    const tenant = requirePermission(request, 'communications.manage');
    const { id } = parseInput(idParams, request.params);
    const row = await withTenant(app.deps.db.db, tenantScope(tenant), (tx) =>
      getConnectionRow(tx, tenant.organizationId, id),
    );
    if (!row.provider.startsWith('fake_')) throw new NotFoundError('Channel');
    const resolved = resolveConnection(app.communications, row);
    const token = resolved.webhookUrl?.split('/').at(-1);
    if (!token || !resolved.credentials.webhookSecret)
      throw new ValidationError('Channel has no webhook credentials');
    return {
      tenant,
      row,
      token,
      url: resolved.webhookUrl ?? '',
      secret: resolved.credentials.webhookSecret,
    };
  }

  async function deliver(target: Awaited<ReturnType<typeof fakeConnection>>, events: unknown[]) {
    const body = JSON.stringify({ events });
    return handleChannelWebhook(
      app.deps.db.db,
      app.communications,
      target.row.provider,
      target.token,
      {
        rawBody: Buffer.from(body),
        headers: { 'x-fake-signature': FakeChannelProvider.sign(body, target.secret) },
        url: target.url,
        query: {},
      },
    );
  }

  app.post('/channels/:id/inbound', async (request) => {
    const target = await fakeConnection(request);
    const input = parseInput(simulateInboundSchema, request.body);
    const outcome = await deliver(target, [
      {
        kind: 'message',
        providerMessageId: `sim_${newId()}`,
        from: input.from,
        fromName: input.fromName ?? null,
        subject: input.subject ?? null,
        text: input.text,
      },
    ]);
    return { outcome };
  });

  app.post('/channels/:id/status', async (request) => {
    const target = await fakeConnection(request);
    const input = parseInput(simulateStatusSchema, request.body);
    const [message] = await withTenant(app.deps.db.db, tenantScope(target.tenant), (tx) =>
      tx
        .select({ providerMessageId: messages.providerMessageId })
        .from(messages)
        .where(and(eq(messages.id, input.messageId), eq(messages.connectionId, target.row.id))),
    );
    if (!message?.providerMessageId) throw new NotFoundError('Message');
    const outcome = await deliver(target, [
      {
        kind: 'status',
        providerMessageId: message.providerMessageId,
        status: input.status,
        error:
          input.status === 'failed' ? { code: 'simulated', message: 'Simulated failure' } : null,
      },
    ]);
    return { outcome };
  });
}
