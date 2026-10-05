import { assertWithinLimit } from '@businessos/billing';
import { assertActiveMember, resolveStage, type CrmContext } from '@businessos/crm';
import {
  appointmentTypes,
  automationEdges,
  automationNodes,
  automationRunLogs,
  automationRuns,
  automationRunSteps,
  automationWorkflows,
  automationWorkflowVersions,
  channelConnections,
  channelTemplates,
  crmTags,
  forms,
  withSystem,
  type AutomationWorkflow,
  type AutomationWorkflowVersion,
  type Database,
  type TenantTx,
} from '@businessos/database';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  type ErrorDetail,
} from '@businessos/shared';
import { createHash, randomBytes } from 'node:crypto';
import { and, asc, count, desc, eq, inArray, max, sql } from 'drizzle-orm';
import { z } from 'zod';
import { definitionSchema, type DefinitionInput, type WorkflowDefinition } from './graph';
import { checkWebhookUrl, HttpRequestError } from './http';
import { TRIGGER_TYPES, type TriggerType } from './triggers';

export const createWorkflowInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1_000).nullable().optional(),
  triggerType: z.enum(TRIGGER_TYPES).default('contact.created'),
});
export const updateWorkflowInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(1_000).nullable(),
  })
  .partial();
export const workflowListQuerySchema = z.object({
  status: z.enum(['draft', 'active', 'paused', 'archived']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export interface VersionView {
  id: string;
  number: number;
  status: AutomationWorkflowVersion['status'];
  definition: WorkflowDefinition;
  publishedAt: string | null;
}

export interface WorkflowSummary {
  id: string;
  name: string;
  description: string | null;
  status: AutomationWorkflow['status'];
  triggerType: string;
  publishedVersion: number | null;
  hasDraft: boolean;
  webhookConfigured: boolean;
  runs: { total: number; failed: number; lastStartedAt: string | null };
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowDetail extends WorkflowSummary {
  draft: VersionView | null;
  published: VersionView | null;
}

export interface WorkflowOptions {
  /** Development/tests: webhook actions may call http:// and private addresses. */
  allowPrivateNetwork: boolean;
  /** BusinessOS's own host names (webhook actions cannot call them). */
  ownHosts?: readonly string[];
}

export function hashWebhookToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

export async function getWorkflowRow(
  tx: TenantTx,
  organizationId: string,
  id: string,
  options: { lock?: boolean } = {},
): Promise<AutomationWorkflow> {
  const query = tx
    .select()
    .from(automationWorkflows)
    .where(
      and(eq(automationWorkflows.id, id), eq(automationWorkflows.organizationId, organizationId)),
    );
  const [row] = options.lock ? await query.for('update') : await query;
  if (!row) throw new NotFoundError('Workflow');
  return row;
}

async function versionsOf(
  tx: TenantTx,
  organizationId: string,
  workflowIds: readonly string[],
  statuses: AutomationWorkflowVersion['status'][],
): Promise<AutomationWorkflowVersion[]> {
  if (workflowIds.length === 0) return [];
  return tx
    .select()
    .from(automationWorkflowVersions)
    .where(
      and(
        eq(automationWorkflowVersions.organizationId, organizationId),
        inArray(automationWorkflowVersions.workflowId, [...workflowIds]),
        inArray(automationWorkflowVersions.status, statuses),
      ),
    );
}

/** Rebuilds a version's definition from its rows (already validated when stored). */
export async function loadDefinition(
  tx: TenantTx,
  version: AutomationWorkflowVersion,
): Promise<WorkflowDefinition> {
  const nodes = await tx
    .select()
    .from(automationNodes)
    .where(
      and(
        eq(automationNodes.versionId, version.id),
        eq(automationNodes.organizationId, version.organizationId),
      ),
    )
    .orderBy(asc(automationNodes.position));
  const edges = await tx
    .select()
    .from(automationEdges)
    .where(
      and(
        eq(automationEdges.versionId, version.id),
        eq(automationEdges.organizationId, version.organizationId),
      ),
    );
  return {
    trigger: { type: version.triggerType as TriggerType, config: version.triggerConfig },
    nodes: nodes.map(
      (node) =>
        ({
          key: node.key,
          type: node.type,
          action: node.action,
          label: node.label,
          config: node.config,
        }) as WorkflowDefinition['nodes'][number],
    ),
    edges: edges.map((edge) => ({ from: edge.fromKey, to: edge.toKey, branch: edge.branch })),
    entry: version.entryNodeKey,
  };
}

async function versionView(tx: TenantTx, version: AutomationWorkflowVersion): Promise<VersionView> {
  return {
    id: version.id,
    number: version.number,
    status: version.status,
    definition: await loadDefinition(tx, version),
    publishedAt: version.publishedAt?.toISOString() ?? null,
  };
}

async function summaries(
  tx: TenantTx,
  organizationId: string,
  rows: AutomationWorkflow[],
): Promise<WorkflowSummary[]> {
  const ids = rows.map((row) => row.id);
  const versions = await versionsOf(tx, organizationId, ids, ['draft', 'published']);
  const stats =
    ids.length === 0
      ? []
      : await tx
          .select({
            workflowId: automationRuns.workflowId,
            total: count(),
            failed: sql<number>`count(*) filter (where ${automationRuns.status} = 'failed')::int`,
            last: max(automationRuns.startedAt),
          })
          .from(automationRuns)
          .where(
            and(
              eq(automationRuns.organizationId, organizationId),
              inArray(automationRuns.workflowId, ids),
            ),
          )
          .groupBy(automationRuns.workflowId);
  return rows.map((row) => {
    const own = versions.filter((version) => version.workflowId === row.id);
    const published = own.find((version) => version.status === 'published');
    const draft = own.find((version) => version.status === 'draft');
    const stat = stats.find((entry) => entry.workflowId === row.id);
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      status: row.status,
      triggerType: (draft ?? published)?.triggerType ?? 'contact.created',
      publishedVersion: published?.number ?? null,
      hasDraft: draft !== undefined,
      webhookConfigured: row.webhookTokenHash !== null,
      runs: {
        total: stat?.total ?? 0,
        failed: stat?.failed ?? 0,
        lastStartedAt: stat?.last?.toISOString() ?? null,
      },
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  });
}

export async function listWorkflows(
  tx: TenantTx,
  organizationId: string,
  rawQuery: z.input<typeof workflowListQuerySchema> = {},
): Promise<{ data: WorkflowSummary[] }> {
  const query = workflowListQuerySchema.parse(rawQuery);
  const conditions = [eq(automationWorkflows.organizationId, organizationId)];
  conditions.push(
    query.status
      ? eq(automationWorkflows.status, query.status)
      : sql`${automationWorkflows.status} <> 'archived'`,
  );
  const rows = await tx
    .select()
    .from(automationWorkflows)
    .where(and(...conditions))
    .orderBy(desc(automationWorkflows.createdAt), desc(automationWorkflows.id))
    .limit(query.limit);
  return { data: await summaries(tx, organizationId, rows) };
}

export async function getWorkflow(
  tx: TenantTx,
  organizationId: string,
  id: string,
): Promise<WorkflowDetail> {
  const row = await getWorkflowRow(tx, organizationId, id);
  const [summary] = await summaries(tx, organizationId, [row]);
  if (!summary) throw new NotFoundError('Workflow');
  const versions = await versionsOf(tx, organizationId, [id], ['draft', 'published']);
  const draft = versions.find((version) => version.status === 'draft');
  const published = versions.find((version) => version.status === 'published');
  return {
    ...summary,
    draft: draft ? await versionView(tx, draft) : null,
    published: published ? await versionView(tx, published) : null,
  };
}

async function lockWorkflows(tx: TenantTx, organizationId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`automation:${organizationId}`}, 0))`,
  );
}

/** `automation.workflows.max` counts workflows that are live (active or paused). */
async function assertWorkflowCapacity(tx: TenantTx, organizationId: string): Promise<void> {
  await lockWorkflows(tx, organizationId);
  const [row] = await tx
    .select({ n: count() })
    .from(automationWorkflows)
    .where(
      and(
        eq(automationWorkflows.organizationId, organizationId),
        inArray(automationWorkflows.status, ['active', 'paused']),
      ),
    );
  await assertWithinLimit(tx, organizationId, 'automation.workflows.max', (row?.n ?? 0) + 1);
}

export async function createWorkflow(
  tx: TenantTx,
  ctx: CrmContext,
  rawInput: z.input<typeof createWorkflowInputSchema>,
): Promise<WorkflowDetail> {
  const input = createWorkflowInputSchema.parse(rawInput);
  const [row] = await tx
    .insert(automationWorkflows)
    .values({
      organizationId: ctx.organizationId,
      name: input.name,
      description: input.description ?? null,
      createdByUserId: ctx.actor.userId,
    })
    .returning();
  if (!row) throw new Error('workflow insert returned no row');
  await tx.insert(automationWorkflowVersions).values({
    organizationId: ctx.organizationId,
    workflowId: row.id,
    number: 1,
    status: 'draft',
    triggerType: input.triggerType,
    triggerConfig: {},
  });
  return getWorkflow(tx, ctx.organizationId, row.id);
}

export async function updateWorkflow(
  tx: TenantTx,
  ctx: CrmContext,
  id: string,
  rawInput: z.input<typeof updateWorkflowInputSchema>,
): Promise<{ workflow: WorkflowDetail; changedFields: string[] }> {
  const input = updateWorkflowInputSchema.parse(rawInput);
  const current = await getWorkflowRow(tx, ctx.organizationId, id, { lock: true });
  const set: Partial<typeof automationWorkflows.$inferInsert> = {};
  if (input.name !== undefined && input.name !== current.name) set.name = input.name;
  if (input.description !== undefined && input.description !== current.description) {
    set.description = input.description;
  }
  const changedFields = Object.keys(set);
  if (changedFields.length > 0) {
    await tx
      .update(automationWorkflows)
      .set({ ...set, updatedAt: new Date() })
      .where(
        and(
          eq(automationWorkflows.id, id),
          eq(automationWorkflows.organizationId, ctx.organizationId),
        ),
      );
  }
  return { workflow: await getWorkflow(tx, ctx.organizationId, id), changedFields };
}

/**
 * Records referenced by the trigger and the steps must be live records of this organization
 * (guessed or foreign ids are refused like any other invalid value).
 */
async function referenceProblems(
  tx: TenantTx,
  organizationId: string,
  definition: WorkflowDefinition,
  options: WorkflowOptions,
): Promise<ErrorDetail[]> {
  const problems: ErrorDetail[] = [];
  const check = async (path: string, ok: () => Promise<boolean>, message: string) => {
    try {
      if (!(await ok())) problems.push({ path, message });
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      problems.push({ path, message: error.details?.[0]?.message ?? error.message });
    }
  };
  const tagExists = async (id: string) =>
    (
      await tx
        .select({ id: crmTags.id })
        .from(crmTags)
        .where(and(eq(crmTags.id, id), eq(crmTags.organizationId, organizationId)))
    ).length > 0;
  const memberOk = async (id: string) => {
    await assertActiveMember(tx, organizationId, id, 'userId');
    return true;
  };
  const stageOk = async (pipelineId: string, stageId: string | null, mustBeOpen: boolean) => {
    const stage = await resolveStage(tx, organizationId, pipelineId, stageId ?? undefined);
    return !mustBeOpen || stage.kind === 'open';
  };

  const config = definition.trigger.config as Record<string, string | null | undefined>;
  const triggerPath = (key: string) => `trigger.config.${key}`;
  if (config.tagId) {
    const tagId = config.tagId;
    await check(triggerPath('tagId'), () => tagExists(tagId), 'Tag not found');
  }
  if (config.formId) {
    const formId = config.formId;
    await check(
      triggerPath('formId'),
      async () =>
        (
          await tx
            .select({ id: forms.id })
            .from(forms)
            .where(and(eq(forms.id, formId), eq(forms.organizationId, organizationId)))
        ).length > 0,
      'Form not found',
    );
  }
  if (config.pipelineId) {
    const pipelineId = config.pipelineId;
    await check(
      triggerPath(config.toStageId ? 'toStageId' : 'pipelineId'),
      () => stageOk(pipelineId, config.toStageId ?? null, false),
      'Pipeline or stage not found',
    );
  }
  if (config.appointmentTypeId) {
    const typeId = config.appointmentTypeId;
    await check(
      triggerPath('appointmentTypeId'),
      async () =>
        (
          await tx
            .select({ id: appointmentTypes.id })
            .from(appointmentTypes)
            .where(
              and(
                eq(appointmentTypes.id, typeId),
                eq(appointmentTypes.organizationId, organizationId),
              ),
            )
        ).length > 0,
      'Appointment type not found',
    );
  }

  for (const [index, node] of definition.nodes.entries()) {
    const path = (key: string) => `nodes.${index}.config.${key}`;
    if (node.type === 'condition') {
      for (const [ruleIndex, rule] of node.config.rules.entries()) {
        if ((rule.operator === 'has_tag' || rule.operator === 'not_has_tag') && rule.value) {
          const tagId = rule.value;
          await check(path(`rules.${ruleIndex}.value`), () => tagExists(tagId), 'Tag not found');
        }
      }
      continue;
    }
    if (node.type !== 'action') continue;
    const action = node.action;
    const nodeConfig = node.config;
    const id = (key: string) => (typeof nodeConfig[key] === 'string' ? nodeConfig[key] : null);
    switch (action) {
      case 'contact.add_tag':
      case 'contact.remove_tag': {
        const tagId = id('tagId') ?? '';
        await check(path('tagId'), () => tagExists(tagId), 'Tag not found');
        break;
      }
      case 'contact.assign_owner':
        await check(path('userId'), () => memberOk(id('userId') ?? ''), 'Not a member');
        break;
      case 'task.create':
        if (id('userId'))
          await check(path('userId'), () => memberOk(id('userId') ?? ''), 'Not a member');
        break;
      case 'deal.create':
        await check(
          path('stageId'),
          () => stageOk(id('pipelineId') ?? '', id('stageId'), true),
          'Choose an open stage of the pipeline',
        );
        break;
      case 'deal.move':
        await check(
          path('stageId'),
          () => stageOk(id('pipelineId') ?? '', id('stageId'), false),
          'Stage not found in the pipeline',
        );
        break;
      case 'message.email':
      case 'message.sms':
      case 'message.whatsapp': {
        const channel = action.slice('message.'.length);
        const connectionId = id('connectionId') ?? '';
        await check(
          path('connectionId'),
          async () =>
            (
              await tx
                .select({ id: channelConnections.id })
                .from(channelConnections)
                .where(
                  and(
                    eq(channelConnections.id, connectionId),
                    eq(channelConnections.organizationId, organizationId),
                    eq(channelConnections.channel, channel as 'email' | 'sms' | 'whatsapp'),
                    sql`${channelConnections.status} <> 'disconnected'`,
                  ),
                )
            ).length > 0,
          `Choose a connected ${channel === 'sms' ? 'SMS' : channel === 'email' ? 'email' : 'WhatsApp'} channel`,
        );
        if (action === 'message.whatsapp') {
          await check(
            path('templateName'),
            async () =>
              (
                await tx
                  .select({ id: channelTemplates.id })
                  .from(channelTemplates)
                  .where(
                    and(
                      eq(channelTemplates.connectionId, connectionId),
                      eq(channelTemplates.organizationId, organizationId),
                      eq(channelTemplates.name, id('templateName') ?? ''),
                      eq(channelTemplates.language, id('language') ?? ''),
                      eq(channelTemplates.status, 'approved'),
                    ),
                  )
              ).length > 0,
            'No approved template with this name and language',
          );
        }
        break;
      }
      case 'http.request':
        try {
          checkWebhookUrl(id('url') ?? '', options.allowPrivateNetwork, options.ownHosts);
        } catch (error) {
          if (!(error instanceof HttpRequestError)) throw error;
          problems.push({ path: path('url'), message: error.message });
        }
        break;
      default:
        break;
    }
  }
  return problems;
}

async function assertValid(
  tx: TenantTx,
  organizationId: string,
  definition: WorkflowDefinition,
  options: WorkflowOptions,
): Promise<void> {
  const problems = await referenceProblems(tx, organizationId, definition, options);
  if (problems.length > 0) throw new ValidationError('Please fix the workflow', problems);
}

async function writeVersionGraph(
  tx: TenantTx,
  organizationId: string,
  versionId: string,
  definition: WorkflowDefinition,
): Promise<void> {
  if (definition.nodes.length > 0) {
    await tx.insert(automationNodes).values(
      definition.nodes.map((node, position) => ({
        organizationId,
        versionId,
        key: node.key,
        type: node.type,
        action: node.type === 'action' ? node.action : null,
        label: node.label,
        config: node.config,
        position,
      })),
    );
  }
  if (definition.edges.length > 0) {
    await tx.insert(automationEdges).values(
      definition.edges.map((edge) => ({
        organizationId,
        versionId,
        fromKey: edge.from,
        toKey: edge.to,
        branch: edge.branch,
      })),
    );
  }
}

/** Replaces the draft (creating the next draft version when only a published one exists). */
export async function saveWorkflowDraft(
  tx: TenantTx,
  ctx: CrmContext,
  id: string,
  rawInput: DefinitionInput,
  options: WorkflowOptions,
): Promise<WorkflowDetail> {
  const definition = definitionSchema.parse(rawInput);
  const workflow = await getWorkflowRow(tx, ctx.organizationId, id, { lock: true });
  if (workflow.status === 'archived')
    throw new ConflictError('Restore the workflow before editing');
  await assertValid(tx, ctx.organizationId, definition, options);
  const [existing] = await versionsOf(tx, ctx.organizationId, [id], ['draft']);
  let versionId: string;
  const header = {
    triggerType: definition.trigger.type,
    triggerConfig: definition.trigger.config,
    entryNodeKey: definition.entry,
  };
  if (existing) {
    versionId = existing.id;
    await tx
      .update(automationWorkflowVersions)
      .set({ ...header, updatedAt: new Date() })
      .where(
        and(
          eq(automationWorkflowVersions.id, versionId),
          eq(automationWorkflowVersions.organizationId, ctx.organizationId),
        ),
      );
    await tx
      .delete(automationEdges)
      .where(
        and(
          eq(automationEdges.versionId, versionId),
          eq(automationEdges.organizationId, ctx.organizationId),
        ),
      );
    await tx
      .delete(automationNodes)
      .where(
        and(
          eq(automationNodes.versionId, versionId),
          eq(automationNodes.organizationId, ctx.organizationId),
        ),
      );
  } else {
    const [latest] = await tx
      .select({ n: max(automationWorkflowVersions.number) })
      .from(automationWorkflowVersions)
      .where(
        and(
          eq(automationWorkflowVersions.workflowId, id),
          eq(automationWorkflowVersions.organizationId, ctx.organizationId),
        ),
      );
    const [created] = await tx
      .insert(automationWorkflowVersions)
      .values({
        organizationId: ctx.organizationId,
        workflowId: id,
        number: (latest?.n ?? 0) + 1,
        status: 'draft',
        ...header,
      })
      .returning();
    if (!created) throw new Error('version insert returned no row');
    versionId = created.id;
  }
  await writeVersionGraph(tx, ctx.organizationId, versionId, definition);
  await tx
    .update(automationWorkflows)
    .set({ updatedAt: new Date() })
    .where(
      and(
        eq(automationWorkflows.id, id),
        eq(automationWorkflows.organizationId, ctx.organizationId),
      ),
    );
  return getWorkflow(tx, ctx.organizationId, id);
}

export async function discardWorkflowDraft(
  tx: TenantTx,
  ctx: CrmContext,
  id: string,
): Promise<WorkflowDetail> {
  await getWorkflowRow(tx, ctx.organizationId, id, { lock: true });
  const versions = await versionsOf(tx, ctx.organizationId, [id], ['draft', 'published']);
  const draft = versions.find((version) => version.status === 'draft');
  if (!draft) throw new ConflictError('There are no unpublished changes');
  if (!versions.some((version) => version.status === 'published')) {
    throw new ConflictError('A workflow that was never published has nothing to go back to');
  }
  await tx
    .delete(automationWorkflowVersions)
    .where(
      and(
        eq(automationWorkflowVersions.id, draft.id),
        eq(automationWorkflowVersions.organizationId, ctx.organizationId),
      ),
    );
  return getWorkflow(tx, ctx.organizationId, id);
}

/**
 * Publishes the draft and makes the workflow active. Runs already in progress finish on the
 * version they started with; new runs use the new one.
 */
export async function publishWorkflow(
  tx: TenantTx,
  ctx: CrmContext,
  id: string,
  options: WorkflowOptions,
): Promise<WorkflowDetail> {
  const workflow = await getWorkflowRow(tx, ctx.organizationId, id, { lock: true });
  if (workflow.status === 'archived')
    throw new ConflictError('Restore the workflow before publishing');
  const [draft] = await versionsOf(tx, ctx.organizationId, [id], ['draft']);
  if (!draft) throw new ConflictError('There are no unpublished changes');
  const definition = definitionSchema.parse(await loadDefinition(tx, draft));
  if (definition.nodes.length === 0) {
    throw new ValidationError('Add at least one step', [{ path: 'nodes', message: 'No steps' }]);
  }
  await assertValid(tx, ctx.organizationId, definition, options);
  if (workflow.status === 'draft') await assertWorkflowCapacity(tx, ctx.organizationId);
  const now = new Date();
  await tx
    .update(automationWorkflowVersions)
    .set({ status: 'retired', updatedAt: now })
    .where(
      and(
        eq(automationWorkflowVersions.workflowId, id),
        eq(automationWorkflowVersions.organizationId, ctx.organizationId),
        eq(automationWorkflowVersions.status, 'published'),
      ),
    );
  await tx
    .update(automationWorkflowVersions)
    .set({
      status: 'published',
      publishedAt: now,
      publishedByUserId: ctx.actor.userId,
      updatedAt: now,
    })
    .where(
      and(
        eq(automationWorkflowVersions.id, draft.id),
        eq(automationWorkflowVersions.organizationId, ctx.organizationId),
      ),
    );
  await tx
    .update(automationWorkflows)
    .set({ status: workflow.status === 'paused' ? 'paused' : 'active', updatedAt: now })
    .where(
      and(
        eq(automationWorkflows.id, id),
        eq(automationWorkflows.organizationId, ctx.organizationId),
      ),
    );
  return getWorkflow(tx, ctx.organizationId, id);
}

/**
 * Pausing stops new runs and holds runs in progress where they are; resuming lets them
 * continue (waits that expired meanwhile continue right away).
 */
export async function setWorkflowPaused(
  tx: TenantTx,
  ctx: CrmContext,
  id: string,
  paused: boolean,
): Promise<WorkflowDetail> {
  const workflow = await getWorkflowRow(tx, ctx.organizationId, id, { lock: true });
  const from = paused ? 'active' : 'paused';
  if (workflow.status !== from) {
    throw new ConflictError(
      paused ? 'Only active workflows can be paused' : 'The workflow is not paused',
    );
  }
  await tx
    .update(automationWorkflows)
    .set({ status: paused ? 'paused' : 'active', updatedAt: new Date() })
    .where(
      and(
        eq(automationWorkflows.id, id),
        eq(automationWorkflows.organizationId, ctx.organizationId),
      ),
    );
  return getWorkflow(tx, ctx.organizationId, id);
}

/** Archiving stops the workflow for good and cancels its runs in progress. */
export async function archiveWorkflow(
  tx: TenantTx,
  ctx: CrmContext,
  id: string,
): Promise<{ workflow: WorkflowDetail; cancelledRuns: number }> {
  const workflow = await getWorkflowRow(tx, ctx.organizationId, id, { lock: true });
  if (workflow.status === 'archived') throw new ConflictError('The workflow is already archived');
  const now = new Date();
  const cancelled = await tx
    .update(automationRuns)
    .set({ status: 'cancelled', finishedAt: now, updatedAt: now, resumeAt: null })
    .where(
      and(
        eq(automationRuns.workflowId, id),
        eq(automationRuns.organizationId, ctx.organizationId),
        inArray(automationRuns.status, ['running', 'waiting']),
      ),
    )
    .returning({ id: automationRuns.id });
  if (cancelled.length > 0) {
    const runIds = cancelled.map((run) => run.id);
    await tx
      .update(automationRunSteps)
      .set({ status: 'cancelled', finishedAt: now, resumeAt: null })
      .where(
        and(
          eq(automationRunSteps.organizationId, ctx.organizationId),
          inArray(automationRunSteps.runId, runIds),
          inArray(automationRunSteps.status, ['running', 'waiting']),
        ),
      );
    await tx.insert(automationRunLogs).values(
      runIds.map((runId) => ({
        organizationId: ctx.organizationId,
        runId,
        level: 'warn' as const,
        message: 'Cancelled: the workflow was archived',
      })),
    );
  }
  await tx
    .update(automationWorkflows)
    .set({ status: 'archived', webhookTokenHash: null, updatedAt: now })
    .where(
      and(
        eq(automationWorkflows.id, id),
        eq(automationWorkflows.organizationId, ctx.organizationId),
      ),
    );
  return {
    workflow: await getWorkflow(tx, ctx.organizationId, id),
    cancelledRuns: cancelled.length,
  };
}

/**
 * Issues a new inbound webhook token (the old one stops working). The token is returned once;
 * only its hash is stored.
 */
export async function rotateWebhookToken(
  tx: TenantTx,
  ctx: CrmContext,
  id: string,
): Promise<{ token: string }> {
  const workflow = await getWorkflowRow(tx, ctx.organizationId, id, { lock: true });
  if (workflow.status === 'archived') throw new ConflictError('The workflow is archived');
  const token = randomBytes(32).toString('base64url');
  await tx
    .update(automationWorkflows)
    .set({ webhookTokenHash: hashWebhookToken(token), updatedAt: new Date() })
    .where(
      and(
        eq(automationWorkflows.id, id),
        eq(automationWorkflows.organizationId, ctx.organizationId),
      ),
    );
  return { token };
}

/**
 * Resolves an inbound webhook token to its workflow. System scope: the caller is anonymous and
 * the token is what identifies the tenant.
 */
export async function findWorkflowByWebhookToken(
  db: Database,
  token: string,
): Promise<{ organizationId: string; workflowId: string } | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  // System scope: the anonymous sender's token is what identifies the tenant.
  const [row] = await withSystem(db, (tx) =>
    tx
      .select({ id: automationWorkflows.id, organizationId: automationWorkflows.organizationId })
      .from(automationWorkflows)
      .where(eq(automationWorkflows.webhookTokenHash, hashWebhookToken(token))),
  );
  return row ? { organizationId: row.organizationId, workflowId: row.id } : null;
}
