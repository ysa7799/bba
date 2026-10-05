import { consumeUsage } from '@businessos/billing';
import { displayName, type CrmContext } from '@businessos/crm';
import {
  automationEdges,
  automationNodes,
  automationRunLogs,
  automationRuns,
  automationRunSteps,
  automationWorkflows,
  automationWorkflowVersions,
  crmContacts,
  organizations,
  withSystem,
  withTenant,
  type AutomationRun,
  type AutomationRunStep,
  type Database,
  type RunStatus,
  type TenantTx,
} from '@businessos/database';
import { emitEvent, type DomainEvent } from '@businessos/events';
import {
  AppError,
  ConflictError,
  decodeCursor,
  encodeCursor,
  EntitlementExceededError,
  NotFoundError,
  ProviderError,
} from '@businessos/shared';
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lte,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { z } from 'zod';
import { ACTIONS, type ActionResult, type ActionType, type QueuedJob } from './actions';
import { evaluateCondition, type ConditionConfig } from './conditions';
import { loadRunContext } from './context';
import { waitMilliseconds, type WaitConfig } from './graph';
import { HttpRequestError } from './http';
import { matchesTrigger, subjectOf, triggersFor, type TriggerType } from './triggers';

/** Runs started by another run's actions may chain this deep (A → B → C → D), no further. */
export const MAX_CHAIN_DEPTH = 3;
/** Per workflow and contact: a hard cap against runaway loops between workflows. */
export const MAX_RUNS_PER_CONTACT_PER_HOUR = 20;
export const RUN_DEADLINE_MS = 90 * 86_400_000;
/** Backoff before attempts 2, 3 and 4 of a failing step; the 4th failure fails the run. */
export const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000] as const;
export const MAX_STEP_ATTEMPTS = RETRY_DELAYS_MS.length + 1;
/** External calls hold their step for this long; a crashed executor's step is retried after. */
const EXTERNAL_LEASE_MS = 2 * 60_000;
/** Steps executed per job before yielding (the run continues in a new job). */
const STEPS_PER_INVOCATION = 60;

export interface AutomationServices {
  /** Development/tests only: the webhook action may call http:// and private addresses. */
  allowPrivateNetwork: boolean;
  /** BusinessOS's own host names (the webhook action refuses them). */
  ownHosts?: readonly string[];
  enqueue: (
    name: 'automation.run' | QueuedJob['name'],
    payload: Record<string, unknown>,
    options: { jobId?: string; delayMs?: number; organizationId: string; correlationId?: string },
  ) => Promise<void>;
  now?: () => Date;
}

const now = (services: AutomationServices) => services.now?.() ?? new Date();

/** Correlation id of everything a run does; events carrying it reveal their origin. */
export function runCorrelationId(runId: string): string {
  return `automation:${runId}`;
}

function parentRunId(correlationId: string | null): string | null {
  const match = /^automation:([0-9a-f-]{36})$/.exec(correlationId ?? '');
  return match?.[1] ?? null;
}

function workflowContext(
  organization: { id: string; countryCode: string; defaultCurrency: string; timezone: string },
  run: Pick<AutomationRun, 'id' | 'workflowId'>,
): CrmContext {
  return {
    organizationId: organization.id,
    countryCode: organization.countryCode,
    defaultCurrency: organization.defaultCurrency,
    timezone: organization.timezone,
    actor: {
      type: 'workflow',
      userId: null,
      workflowId: run.workflowId,
      correlationId: runCorrelationId(run.id),
    },
  };
}

async function log(
  tx: TenantTx,
  run: Pick<AutomationRun, 'id' | 'organizationId'>,
  level: 'info' | 'warn' | 'error',
  message: string,
  nodeKey: string | null = null,
) {
  await tx.insert(automationRunLogs).values({
    organizationId: run.organizationId,
    runId: run.id,
    nodeKey,
    level,
    message: message.slice(0, 1_000),
  });
}

function workflowActor(workflowId: string) {
  return { type: 'workflow' as const, id: workflowId };
}

// ── Starting runs ───────────────────────────────────────────────────────────────────────

interface NewRun {
  organizationId: string;
  workflowId: string;
  versionId: string;
  triggerType: string;
  dedupeKey: string;
  sourceEventId: string | null;
  contactId: string | null;
  dealId: string | null;
  triggerData: Record<string, unknown>;
  depth: number;
  parentRunId: string | null;
  skipReason: string | null;
}

/**
 * Inserts a run once per (workflow, trigger occurrence). Returns null for a duplicate. Started
 * runs consume the monthly execution quota; over it, the run is recorded as skipped.
 */
async function insertRun(tx: TenantTx, input: NewRun, at: Date): Promise<AutomationRun | null> {
  const [run] = await tx
    .insert(automationRuns)
    .values({
      organizationId: input.organizationId,
      workflowId: input.workflowId,
      versionId: input.versionId,
      status: input.skipReason ? 'skipped' : 'running',
      triggerType: input.triggerType,
      dedupeKey: input.dedupeKey,
      sourceEventId: input.sourceEventId,
      contactId: input.contactId,
      dealId: input.dealId,
      triggerData: input.triggerData,
      depth: input.depth,
      parentRunId: input.parentRunId,
      deadlineAt: new Date(at.getTime() + RUN_DEADLINE_MS),
      error: input.skipReason,
      startedAt: at,
      updatedAt: at,
      finishedAt: input.skipReason ? at : null,
    })
    .onConflictDoNothing({ target: [automationRuns.workflowId, automationRuns.dedupeKey] })
    .returning();
  if (!run) return null;
  if (run.status === 'skipped') {
    await log(tx, run, 'warn', `Not started: ${input.skipReason ?? ''}`);
    return run;
  }
  try {
    await tx.transaction((sp) =>
      consumeUsage(sp, input.organizationId, 'automation.monthly_executions', 1, {
        idempotencyKey: `automation-run:${run.id}`,
        source: 'automation.run',
        at,
      }),
    );
  } catch (error) {
    if (!(error instanceof EntitlementExceededError)) throw error;
    const reason = 'The monthly workflow run limit of the plan is reached';
    await tx
      .update(automationRuns)
      .set({ status: 'skipped', error: reason, finishedAt: at })
      .where(
        and(eq(automationRuns.id, run.id), eq(automationRuns.organizationId, run.organizationId)),
      );
    await log(tx, run, 'warn', `Not started: ${reason}`);
    return { ...run, status: 'skipped', error: reason };
  }
  await emitEvent(tx, {
    organizationId: input.organizationId,
    actor: workflowActor(run.workflowId),
    correlationId: runCorrelationId(run.id),
    causationId: input.sourceEventId,
    type: 'workflow.started',
    subject: { type: 'workflow_run', id: run.id },
    payload: {
      workflowId: run.workflowId,
      versionId: run.versionId,
      runId: run.id,
      triggerType: run.triggerType,
    },
  });
  await log(tx, run, 'info', `Started by ${run.triggerType}`);
  return run;
}

/** Loop protection for runs caused by another run's actions (see ADR-044). */
async function skipReasonFor(
  tx: TenantTx,
  organizationId: string,
  workflowId: string,
  parent: AutomationRun | null,
  contactId: string | null,
  at: Date,
): Promise<string | null> {
  if (parent?.workflowId === workflowId) {
    return "Loop protection: the workflow's own actions cannot start it again";
  }
  if (parent && parent.depth + 1 > MAX_CHAIN_DEPTH) {
    return `Loop protection: more than ${MAX_CHAIN_DEPTH} workflows started each other in a chain`;
  }
  if (contactId) {
    const [recent] = await tx
      .select({ n: count() })
      .from(automationRuns)
      .where(
        and(
          eq(automationRuns.organizationId, organizationId),
          eq(automationRuns.workflowId, workflowId),
          eq(automationRuns.contactId, contactId),
          gte(automationRuns.startedAt, new Date(at.getTime() - 3_600_000)),
          sql`${automationRuns.status} <> 'skipped'`,
        ),
      );
    if ((recent?.n ?? 0) >= MAX_RUNS_PER_CONTACT_PER_HOUR) {
      return `Loop protection: more than ${MAX_RUNS_PER_CONTACT_PER_HOUR} runs for this contact within an hour`;
    }
  }
  return null;
}

async function enqueueRun(
  services: AutomationServices,
  run: Pick<AutomationRun, 'id' | 'organizationId'>,
  key: string,
  delayMs = 0,
) {
  await services.enqueue(
    'automation.run',
    { organizationId: run.organizationId, runId: run.id },
    {
      jobId: `automation-run-${run.id}-${key}`,
      organizationId: run.organizationId,
      correlationId: runCorrelationId(run.id),
      ...(delayMs > 0 ? { delayMs } : {}),
    },
  );
}

/**
 * Starts the runs a domain event triggers. Idempotent: a redelivered event finds its runs
 * already recorded (unique per workflow and event) and only re-queues them.
 */
export async function startRunsForEvent(
  db: Database,
  services: AutomationServices,
  event: DomainEvent,
): Promise<string[]> {
  const organizationId = event.organizationId;
  const triggers = triggersFor(event.type);
  if (!organizationId || triggers.length === 0) return [];
  const at = now(services);
  const runs = await withTenant(db, { organizationId, userId: null }, async (tx) => {
    const candidates = await tx
      .select({ version: automationWorkflowVersions })
      .from(automationWorkflowVersions)
      .innerJoin(
        automationWorkflows,
        and(
          eq(automationWorkflows.id, automationWorkflowVersions.workflowId),
          eq(automationWorkflows.organizationId, automationWorkflowVersions.organizationId),
        ),
      )
      .where(
        and(
          eq(automationWorkflowVersions.organizationId, organizationId),
          eq(automationWorkflowVersions.status, 'published'),
          inArray(automationWorkflowVersions.triggerType, triggers),
          eq(automationWorkflows.status, 'active'),
        ),
      );
    const matching = candidates
      .map((row) => row.version)
      .filter((version) =>
        matchesTrigger(version.triggerType as TriggerType, version.triggerConfig, event),
      );
    if (matching.length === 0) return [];
    const subject = await subjectOf(tx, organizationId, event);
    const parentId = parentRunId(event.correlationId);
    const [parent] = parentId
      ? await tx
          .select()
          .from(automationRuns)
          .where(
            and(eq(automationRuns.id, parentId), eq(automationRuns.organizationId, organizationId)),
          )
      : [];
    const started: AutomationRun[] = [];
    for (const version of matching) {
      const skipReason = await skipReasonFor(
        tx,
        organizationId,
        version.workflowId,
        parent ?? null,
        subject.contactId,
        at,
      );
      const run =
        (await insertRun(
          tx,
          {
            organizationId,
            workflowId: version.workflowId,
            versionId: version.id,
            triggerType: version.triggerType,
            dedupeKey: `event:${event.id}`,
            sourceEventId: event.id,
            contactId: subject.contactId,
            dealId: subject.dealId,
            triggerData: event.payload,
            depth: parent ? parent.depth + 1 : 0,
            parentRunId: parent?.id ?? null,
            skipReason,
          },
          at,
        )) ??
        // Redelivered event: the run exists already; make sure it gets executed.
        (
          await tx
            .select()
            .from(automationRuns)
            .where(
              and(
                eq(automationRuns.organizationId, organizationId),
                eq(automationRuns.workflowId, version.workflowId),
                eq(automationRuns.dedupeKey, `event:${event.id}`),
              ),
            )
        )[0];
      if (run && (run.status === 'running' || run.status === 'waiting')) started.push(run);
    }
    return started;
  });
  for (const run of runs) await enqueueRun(services, run, 'start');
  return runs.map((run) => run.id);
}

/** Starts a run of a webhook-triggered workflow. `deliveryKey` deduplicates sender retries. */
export async function startRunFromWebhook(
  db: Database,
  services: AutomationServices,
  target: { organizationId: string; workflowId: string },
  body: Record<string, unknown>,
  deliveryKey: string,
): Promise<{ runId: string; duplicate: boolean }> {
  const at = now(services);
  const result = await withTenant(
    db,
    { organizationId: target.organizationId, userId: null },
    async (tx) => {
      const [workflow] = await tx
        .select()
        .from(automationWorkflows)
        .where(
          and(
            eq(automationWorkflows.id, target.workflowId),
            eq(automationWorkflows.organizationId, target.organizationId),
          ),
        );
      if (workflow?.status !== 'active') throw new NotFoundError('Workflow');
      const [version] = await tx
        .select()
        .from(automationWorkflowVersions)
        .where(
          and(
            eq(automationWorkflowVersions.workflowId, workflow.id),
            eq(automationWorkflowVersions.organizationId, target.organizationId),
            eq(automationWorkflowVersions.status, 'published'),
          ),
        );
      if (version?.triggerType !== 'webhook.received') {
        throw new ConflictError('This workflow is not started by webhooks');
      }
      const dedupeKey = `webhook:${deliveryKey}`;
      const run = await insertRun(
        tx,
        {
          organizationId: target.organizationId,
          workflowId: workflow.id,
          versionId: version.id,
          triggerType: version.triggerType,
          dedupeKey,
          sourceEventId: null,
          contactId: null,
          dealId: null,
          triggerData: { body },
          depth: 0,
          parentRunId: null,
          skipReason: null,
        },
        at,
      );
      if (run) return { run, duplicate: false };
      const [existing] = await tx
        .select()
        .from(automationRuns)
        .where(
          and(
            eq(automationRuns.organizationId, target.organizationId),
            eq(automationRuns.workflowId, workflow.id),
            eq(automationRuns.dedupeKey, dedupeKey),
          ),
        );
      if (!existing) throw new ConflictError('Please send the webhook again');
      return { run: existing, duplicate: true };
    },
  );
  if (result.run.status === 'running') await enqueueRun(services, result.run, 'start');
  return { runId: result.run.id, duplicate: result.duplicate };
}

// ── Executing runs ──────────────────────────────────────────────────────────────────────

interface Graph {
  entry: string | null;
  nodes: Map<string, typeof automationNodes.$inferSelect>;
  next: (from: string, branch: string) => string | null;
}

async function loadGraph(tx: TenantTx, run: AutomationRun): Promise<Graph> {
  const [version] = await tx
    .select()
    .from(automationWorkflowVersions)
    .where(
      and(
        eq(automationWorkflowVersions.id, run.versionId),
        eq(automationWorkflowVersions.organizationId, run.organizationId),
      ),
    );
  if (!version) throw new NotFoundError('Workflow version');
  const nodes = await tx
    .select()
    .from(automationNodes)
    .where(
      and(
        eq(automationNodes.versionId, version.id),
        eq(automationNodes.organizationId, run.organizationId),
      ),
    );
  const edges = await tx
    .select()
    .from(automationEdges)
    .where(
      and(
        eq(automationEdges.versionId, version.id),
        eq(automationEdges.organizationId, run.organizationId),
      ),
    );
  return {
    entry: version.entryNodeKey,
    nodes: new Map(nodes.map((node) => [node.key, node])),
    next: (from, branch) =>
      edges.find((edge) => edge.fromKey === from && edge.branch === branch)?.toKey ?? null,
  };
}

export type StepOutcome =
  | { kind: 'advanced'; jobs: QueuedJob[] }
  | { kind: 'external'; nodeKey: string; action: ActionType; config: Record<string, unknown> }
  | { kind: 'waiting'; resumeAt: Date; jobs: QueuedJob[] }
  | { kind: 'completed' | 'failed' | 'cancelled'; jobs: QueuedJob[] }
  | { kind: 'busy' | 'paused' | 'not_due' | 'done' };

/** Errors that will not get better by retrying (bad configuration, missing records, quotas). */
function isPermanent(error: unknown): boolean {
  if (error instanceof HttpRequestError) return !error.retryable;
  if (error instanceof ProviderError) return !error.retryable;
  return error instanceof AppError;
}

function describe(error: unknown): string {
  if (error instanceof AppError || error instanceof HttpRequestError) {
    const detail = error instanceof AppError ? error.details?.[0]?.message : undefined;
    return detail && detail !== error.message ? `${error.message} (${detail})` : error.message;
  }
  return 'Unexpected error';
}

async function lockRun(tx: TenantTx, organizationId: string, runId: string) {
  const [run] = await tx
    .select()
    .from(automationRuns)
    .where(and(eq(automationRuns.id, runId), eq(automationRuns.organizationId, organizationId)))
    .for('update', { skipLocked: true });
  return run;
}

async function stepOf(tx: TenantTx, run: AutomationRun, nodeKey: string) {
  const [step] = await tx
    .select()
    .from(automationRunSteps)
    .where(
      and(
        eq(automationRunSteps.runId, run.id),
        eq(automationRunSteps.organizationId, run.organizationId),
        eq(automationRunSteps.nodeKey, nodeKey),
      ),
    );
  return step;
}

async function saveStep(
  tx: TenantTx,
  run: AutomationRun,
  node: typeof automationNodes.$inferSelect,
  existing: AutomationRunStep | undefined,
  values: Partial<typeof automationRunSteps.$inferInsert>,
): Promise<void> {
  if (existing) {
    await tx
      .update(automationRunSteps)
      .set(values)
      .where(
        and(
          eq(automationRunSteps.id, existing.id),
          eq(automationRunSteps.organizationId, run.organizationId),
        ),
      );
    return;
  }
  await tx.insert(automationRunSteps).values({
    organizationId: run.organizationId,
    runId: run.id,
    nodeKey: node.key,
    nodeType: node.type,
    action: node.action,
    status: 'running',
    ...values,
  });
}

async function finishRun(
  tx: TenantTx,
  run: AutomationRun,
  status: 'completed' | 'failed' | 'cancelled',
  at: Date,
  error: string | null = null,
): Promise<void> {
  await tx
    .update(automationRuns)
    .set({ status, error, finishedAt: at, updatedAt: at, resumeAt: null })
    .where(
      and(eq(automationRuns.id, run.id), eq(automationRuns.organizationId, run.organizationId)),
    );
  const meta = {
    organizationId: run.organizationId,
    actor: workflowActor(run.workflowId),
    correlationId: runCorrelationId(run.id),
    subject: { type: 'workflow_run', id: run.id },
  };
  if (status === 'completed') {
    await emitEvent(tx, {
      ...meta,
      type: 'workflow.completed',
      payload: { workflowId: run.workflowId, runId: run.id },
    });
    await log(tx, run, 'info', 'Completed');
  } else if (status === 'failed') {
    await emitEvent(tx, {
      ...meta,
      type: 'workflow.failed',
      payload: {
        workflowId: run.workflowId,
        runId: run.id,
        error: (error ?? 'Failed').slice(0, 500),
      },
    });
    await log(tx, run, 'error', `Failed: ${error ?? ''}`);
  }
}

async function advance(
  tx: TenantTx,
  run: AutomationRun,
  graph: Graph,
  nodeKey: string,
  branch: string,
  at: Date,
  jobs: QueuedJob[],
): Promise<StepOutcome> {
  const next = graph.next(nodeKey, branch);
  if (!next) {
    await finishRun(tx, run, 'completed', at);
    return { kind: 'completed', jobs };
  }
  await tx
    .update(automationRuns)
    .set({ currentNodeKey: next, status: 'running', resumeAt: null, updatedAt: at })
    .where(
      and(eq(automationRuns.id, run.id), eq(automationRuns.organizationId, run.organizationId)),
    );
  return { kind: 'advanced', jobs };
}

/** Records a failed attempt: retries later with backoff, or fails the run. */
async function recordFailure(
  tx: TenantTx,
  run: AutomationRun,
  node: typeof automationNodes.$inferSelect,
  step: AutomationRunStep | undefined,
  attempts: number,
  error: unknown,
  at: Date,
): Promise<StepOutcome> {
  const message = describe(error);
  const delay = RETRY_DELAYS_MS[attempts - 1];
  if (!isPermanent(error) && delay !== undefined) {
    const resumeAt = new Date(at.getTime() + delay);
    await saveStep(tx, run, node, step, { status: 'waiting', attempts, resumeAt, error: message });
    await tx
      .update(automationRuns)
      .set({ status: 'waiting', resumeAt, updatedAt: at })
      .where(
        and(eq(automationRuns.id, run.id), eq(automationRuns.organizationId, run.organizationId)),
      );
    await log(tx, run, 'warn', `Attempt ${attempts} failed, retrying: ${message}`, node.key);
    return { kind: 'waiting', resumeAt, jobs: [] };
  }
  await saveStep(tx, run, node, step, {
    status: 'failed',
    attempts,
    error: message,
    finishedAt: at,
    resumeAt: null,
  });
  await finishRun(tx, run, 'failed', at, `${node.label ?? node.action ?? node.type}: ${message}`);
  return { kind: 'failed', jobs: [] };
}

/** Executes (or resumes) the run's current step inside one transaction. */
async function executeStep(
  db: Database,
  services: AutomationServices,
  organizationId: string,
  runId: string,
): Promise<StepOutcome> {
  return withTenant(db, { organizationId, userId: null }, async (tx) => {
    const at = now(services);
    const run = await lockRun(tx, organizationId, runId);
    if (!run) return { kind: 'busy' };
    if (run.status !== 'running' && run.status !== 'waiting') return { kind: 'done' };
    if (run.resumeAt && run.resumeAt > at) return { kind: 'not_due' };
    const [workflow] = await tx
      .select({ status: automationWorkflows.status })
      .from(automationWorkflows)
      .where(
        and(
          eq(automationWorkflows.id, run.workflowId),
          eq(automationWorkflows.organizationId, organizationId),
        ),
      );
    if (workflow?.status === 'paused') return { kind: 'paused' };
    if (!workflow || workflow.status === 'archived') {
      await finishRun(tx, run, 'cancelled', at);
      await log(tx, run, 'warn', 'Cancelled: the workflow was archived');
      return { kind: 'cancelled', jobs: [] };
    }
    if (at > run.deadlineAt) {
      await finishRun(tx, run, 'failed', at, 'Timed out: the run did not finish within 90 days');
      return { kind: 'failed', jobs: [] };
    }
    const graph = await loadGraph(tx, run);
    const nodeKey = run.currentNodeKey ?? graph.entry;
    if (!nodeKey) {
      await finishRun(tx, run, 'completed', at);
      return { kind: 'completed', jobs: [] };
    }
    if (run.currentNodeKey === null) {
      await tx
        .update(automationRuns)
        .set({ currentNodeKey: nodeKey })
        .where(
          and(eq(automationRuns.id, run.id), eq(automationRuns.organizationId, organizationId)),
        );
    }
    const node = graph.nodes.get(nodeKey);
    if (!node) {
      await finishRun(tx, run, 'failed', at, `Step ${nodeKey} no longer exists`);
      return { kind: 'failed', jobs: [] };
    }
    const step = await stepOf(tx, run, nodeKey);
    if (step?.status === 'succeeded') {
      // Already done (e.g. the previous job stopped after committing): just move on.
      const branch = typeof step.output.branch === 'string' ? step.output.branch : 'next';
      return advance(tx, run, graph, nodeKey, branch, at, []);
    }
    if (step?.status === 'failed' || step?.status === 'cancelled') return { kind: 'done' };
    if (step?.resumeAt && step.resumeAt > at) {
      if (step.status === 'running') return { kind: 'busy' };
      await tx
        .update(automationRuns)
        .set({ status: 'waiting', resumeAt: step.resumeAt, updatedAt: at })
        .where(
          and(eq(automationRuns.id, run.id), eq(automationRuns.organizationId, organizationId)),
        );
      return { kind: 'waiting', resumeAt: step.resumeAt, jobs: [] };
    }

    if (node.type === 'wait') {
      if (!step) {
        const resumeAt = new Date(at.getTime() + waitMilliseconds(node.config as WaitConfig));
        await saveStep(tx, run, node, step, { status: 'waiting', resumeAt });
        await tx
          .update(automationRuns)
          .set({ status: 'waiting', resumeAt, updatedAt: at })
          .where(
            and(eq(automationRuns.id, run.id), eq(automationRuns.organizationId, organizationId)),
          );
        await log(tx, run, 'info', `Waiting until ${resumeAt.toISOString()}`, node.key);
        return { kind: 'waiting', resumeAt, jobs: [] };
      }
      await saveStep(tx, run, node, step, { status: 'succeeded', finishedAt: at, resumeAt: null });
      return advance(tx, run, graph, nodeKey, 'next', at, []);
    }

    const [organization] = await tx
      .select()
      .from(organizations)
      .where(eq(organizations.id, organizationId));
    if (!organization) throw new NotFoundError('Organization');
    const crm = workflowContext(organization, run);
    const context = await loadRunContext(tx, crm, run);

    if (node.type === 'condition') {
      const result = evaluateCondition(node.config as ConditionConfig, context);
      const branch = result ? 'true' : 'false';
      await saveStep(tx, run, node, step, {
        status: 'succeeded',
        output: { result, branch },
        finishedAt: at,
        attempts: 1,
      });
      await log(tx, run, 'info', `Condition is ${result ? 'true' : 'false'}`, node.key);
      return advance(tx, run, graph, nodeKey, branch, at, []);
    }

    const action = node.action as ActionType;
    const definition = ACTIONS[action];
    const attempts = (step?.attempts ?? 0) + 1;
    if (definition.requires === 'contact' && !context.contact) {
      return recordFailure(
        tx,
        run,
        node,
        step,
        attempts,
        new ConflictError('This step needs a contact; the run has none'),
        at,
      );
    }
    if (definition.requires === 'deal' && !context.deal) {
      return recordFailure(
        tx,
        run,
        node,
        step,
        attempts,
        new ConflictError('This step needs a deal; the run has none'),
        at,
      );
    }
    if ('external' in definition && definition.external) {
      // Claimed for a while; the call itself happens outside the transaction.
      await saveStep(tx, run, node, step, {
        status: 'running',
        attempts,
        resumeAt: new Date(at.getTime() + EXTERNAL_LEASE_MS),
      });
      await tx
        .update(automationRuns)
        .set({ status: 'running', resumeAt: null, updatedAt: at })
        .where(
          and(eq(automationRuns.id, run.id), eq(automationRuns.organizationId, organizationId)),
        );
      return { kind: 'external', nodeKey, action, config: node.config };
    }
    let result: ActionResult;
    try {
      result = await tx.transaction((sp) =>
        (definition.run as (ctx: unknown, config: unknown) => Promise<ActionResult>)(
          { tx: sp as TenantTx, crm, run, nodeKey, context, now: at },
          definition.schema.parse(node.config),
        ),
      );
    } catch (error) {
      return recordFailure(tx, run, node, step, attempts, error, at);
    }
    await saveStep(tx, run, node, step, {
      status: 'succeeded',
      attempts,
      output: result.output,
      error: null,
      resumeAt: null,
      finishedAt: at,
    });
    if (result.contactId || result.dealId) {
      await tx
        .update(automationRuns)
        .set({
          ...(result.contactId ? { contactId: result.contactId } : {}),
          ...(result.dealId ? { dealId: result.dealId } : {}),
        })
        .where(
          and(eq(automationRuns.id, run.id), eq(automationRuns.organizationId, organizationId)),
        );
    }
    await log(tx, run, 'info', `${node.label ?? action} done`, node.key);
    return advance(tx, run, graph, nodeKey, 'next', at, result.jobs ?? []);
  });
}

/** Performs an external action claimed by `executeStep`, then records the result. */
async function executeExternal(
  db: Database,
  services: AutomationServices,
  organizationId: string,
  runId: string,
  claim: Extract<StepOutcome, { kind: 'external' }>,
): Promise<StepOutcome> {
  const prepared = await withTenant(db, { organizationId, userId: null }, async (tx) => {
    const [run] = await tx
      .select()
      .from(automationRuns)
      .where(and(eq(automationRuns.id, runId), eq(automationRuns.organizationId, organizationId)));
    const [organization] = await tx
      .select()
      .from(organizations)
      .where(eq(organizations.id, organizationId));
    if (!run || !organization) return null;
    return { run, context: await loadRunContext(tx, workflowContext(organization, run), run) };
  });
  if (!prepared) return { kind: 'done' };
  const definition = ACTIONS[claim.action];
  let outcome: { result: ActionResult } | { error: unknown };
  try {
    const run = definition.runExternal as (ctx: unknown, config: unknown) => Promise<ActionResult>;
    outcome = {
      result: await run(
        {
          run: prepared.run,
          nodeKey: claim.nodeKey,
          context: prepared.context,
          allowPrivateNetwork: services.allowPrivateNetwork,
          ownHosts: services.ownHosts ?? [],
        },
        definition.schema.parse(claim.config),
      ),
    };
  } catch (error) {
    outcome = { error };
  }
  return withTenant(db, { organizationId, userId: null }, async (tx) => {
    const at = now(services);
    const run = await lockRun(tx, organizationId, runId);
    if (run?.status !== 'running' && run?.status !== 'waiting') return { kind: 'done' };
    const graph = await loadGraph(tx, run);
    const node = graph.nodes.get(claim.nodeKey);
    const step = await stepOf(tx, run, claim.nodeKey);
    if (!node || step?.status !== 'running') return { kind: 'done' };
    if ('error' in outcome)
      return recordFailure(tx, run, node, step, step.attempts, outcome.error, at);
    await saveStep(tx, run, node, step, {
      status: 'succeeded',
      output: outcome.result.output,
      error: null,
      resumeAt: null,
      finishedAt: at,
    });
    await log(tx, run, 'info', `${node.label ?? claim.action} done`, node.key);
    return advance(tx, run, graph, claim.nodeKey, 'next', at, []);
  });
}

export type RunOutcome =
  'completed' | 'failed' | 'cancelled' | 'waiting' | 'busy' | 'paused' | 'done' | 'yielded';

/**
 * Executes a run step by step (each step commits on its own) until it waits, finishes, fails
 * or yields. Safe to call concurrently and repeatedly for the same run.
 */
export async function executeRun(
  db: Database,
  services: AutomationServices,
  organizationId: string,
  runId: string,
): Promise<RunOutcome> {
  for (let i = 0; i < STEPS_PER_INVOCATION; i += 1) {
    let outcome = await executeStep(db, services, organizationId, runId);
    if (outcome.kind === 'external') {
      outcome = await executeExternal(db, services, organizationId, runId, outcome);
    }
    if ('jobs' in outcome) {
      for (const job of outcome.jobs) {
        await services.enqueue(job.name, job.payload, {
          jobId: job.jobId,
          organizationId,
          correlationId: runCorrelationId(runId),
        });
      }
    }
    switch (outcome.kind) {
      case 'advanced':
        continue;
      case 'waiting': {
        const delay = Math.max(0, outcome.resumeAt.getTime() - now(services).getTime());
        await enqueueRun(
          services,
          { id: runId, organizationId },
          String(outcome.resumeAt.getTime()),
          delay,
        );
        return 'waiting';
      }
      case 'not_due':
        return 'waiting';
      case 'external':
        return 'busy';
      default:
        return outcome.kind;
    }
  }
  await enqueueRun(services, { id: runId, organizationId }, `yield-${Date.now()}`);
  return 'yielded';
}

/**
 * Durable continuation: queues runs whose wait or retry is due and runs that stalled (a job
 * lost with Redis, a crashed worker). The database is the source of truth, not the queue.
 */
export async function resumeDueRuns(
  db: Database,
  services: AutomationServices,
  limit = 500,
): Promise<{ queued: number }> {
  const at = now(services);
  const stalledBefore = new Date(at.getTime() - 2 * 60_000);
  // System scope: the scheduler looks across tenants for due runs; each run then executes
  // inside its own tenant.
  const due = await withSystem(db, (tx) =>
    tx
      .select({ id: automationRuns.id, organizationId: automationRuns.organizationId })
      .from(automationRuns)
      .innerJoin(
        automationWorkflows,
        and(
          eq(automationWorkflows.id, automationRuns.workflowId),
          eq(automationWorkflows.organizationId, automationRuns.organizationId),
        ),
      )
      .where(
        and(
          eq(automationWorkflows.status, 'active'),
          or(
            and(eq(automationRuns.status, 'waiting'), lte(automationRuns.resumeAt, at)),
            and(eq(automationRuns.status, 'running'), lte(automationRuns.updatedAt, stalledBefore)),
          ),
        ),
      )
      .orderBy(asc(automationRuns.resumeAt))
      .limit(limit),
  );
  for (const run of due)
    await enqueueRun(services, run, `resume-${Math.floor(at.getTime() / 60_000)}`);
  return { queued: due.length };
}

// ── Staff operations and views ──────────────────────────────────────────────────────────

async function runForUpdate(tx: TenantTx, organizationId: string, runId: string) {
  const [run] = await tx
    .select()
    .from(automationRuns)
    .where(and(eq(automationRuns.id, runId), eq(automationRuns.organizationId, organizationId)))
    .for('update');
  if (!run) throw new NotFoundError('Run');
  return run;
}

/** Retries a failed run from the step that failed (steps that succeeded are not repeated). */
export async function retryRun(
  tx: TenantTx,
  ctx: CrmContext,
  runId: string,
): Promise<AutomationRun> {
  const run = await runForUpdate(tx, ctx.organizationId, runId);
  if (run.status !== 'failed') throw new ConflictError('Only failed runs can be retried');
  const at = new Date();
  await tx
    .update(automationRunSteps)
    .set({ status: 'waiting', attempts: 0, resumeAt: at, error: null, finishedAt: null })
    .where(
      and(
        eq(automationRunSteps.runId, run.id),
        eq(automationRunSteps.organizationId, ctx.organizationId),
        eq(automationRunSteps.status, 'failed'),
      ),
    );
  const deadline = new Date(Math.max(run.deadlineAt.getTime(), at.getTime() + 7 * 86_400_000));
  const [updated] = await tx
    .update(automationRuns)
    .set({
      status: 'running',
      error: null,
      finishedAt: null,
      resumeAt: null,
      deadlineAt: deadline,
      updatedAt: at,
    })
    .where(
      and(eq(automationRuns.id, run.id), eq(automationRuns.organizationId, ctx.organizationId)),
    )
    .returning();
  await log(tx, run, 'info', 'Retried manually');
  if (!updated) throw new NotFoundError('Run');
  return updated;
}

export async function cancelRun(
  tx: TenantTx,
  ctx: CrmContext,
  runId: string,
): Promise<AutomationRun> {
  const run = await runForUpdate(tx, ctx.organizationId, runId);
  if (run.status !== 'running' && run.status !== 'waiting') {
    throw new ConflictError('Only runs in progress can be cancelled');
  }
  const at = new Date();
  await tx
    .update(automationRunSteps)
    .set({ status: 'cancelled', finishedAt: at, resumeAt: null })
    .where(
      and(
        eq(automationRunSteps.runId, run.id),
        eq(automationRunSteps.organizationId, ctx.organizationId),
        inArray(automationRunSteps.status, ['running', 'waiting']),
      ),
    );
  await finishRun(tx, run, 'cancelled', at);
  await log(tx, run, 'warn', 'Cancelled manually');
  const [updated] = await tx
    .select()
    .from(automationRuns)
    .where(
      and(eq(automationRuns.id, run.id), eq(automationRuns.organizationId, ctx.organizationId)),
    );
  if (!updated) throw new NotFoundError('Run');
  return updated;
}

export const runListQuerySchema = z.object({
  status: z.enum(['running', 'waiting', 'completed', 'failed', 'cancelled', 'skipped']).optional(),
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export interface RunSummary {
  id: string;
  workflowId: string;
  versionNumber: number;
  status: RunStatus;
  triggerType: string;
  contact: { id: string; name: string } | null;
  dealId: string | null;
  currentNodeKey: string | null;
  resumeAt: string | null;
  error: string | null;
  depth: number;
  startedAt: string;
  finishedAt: string | null;
}

export interface RunDetail extends RunSummary {
  triggerData: Record<string, unknown>;
  steps: {
    nodeKey: string;
    nodeType: string;
    action: string | null;
    status: string;
    attempts: number;
    resumeAt: string | null;
    output: Record<string, unknown>;
    error: string | null;
    startedAt: string;
    finishedAt: string | null;
  }[];
  logs: { nodeKey: string | null; level: string; message: string; at: string }[];
}

async function runSummaries(
  tx: TenantTx,
  ctx: CrmContext,
  rows: AutomationRun[],
): Promise<RunSummary[]> {
  const versionIds = [...new Set(rows.map((row) => row.versionId))];
  const numbers =
    versionIds.length === 0
      ? []
      : await tx
          .select({ id: automationWorkflowVersions.id, number: automationWorkflowVersions.number })
          .from(automationWorkflowVersions)
          .where(
            and(
              eq(automationWorkflowVersions.organizationId, ctx.organizationId),
              inArray(automationWorkflowVersions.id, versionIds),
            ),
          );
  const contactIds = [
    ...new Set(rows.map((row) => row.contactId).filter((id): id is string => id !== null)),
  ];
  const contacts =
    (ctx.canRead?.contact ?? true) && contactIds.length > 0
      ? await tx
          .select()
          .from(crmContacts)
          .where(
            and(
              eq(crmContacts.organizationId, ctx.organizationId),
              inArray(crmContacts.id, contactIds),
              isNull(crmContacts.deletedAt),
            ),
          )
      : [];
  return rows.map((row) => {
    const contact = contacts.find((entry) => entry.id === row.contactId);
    return {
      id: row.id,
      workflowId: row.workflowId,
      versionNumber: numbers.find((entry) => entry.id === row.versionId)?.number ?? 0,
      status: row.status,
      triggerType: row.triggerType,
      contact: contact ? { id: contact.id, name: displayName(contact) } : null,
      dealId: (ctx.canRead?.deal ?? true) ? row.dealId : null,
      currentNodeKey: row.currentNodeKey,
      resumeAt: row.resumeAt?.toISOString() ?? null,
      error: row.error,
      depth: row.depth,
      startedAt: row.startedAt.toISOString(),
      finishedAt: row.finishedAt?.toISOString() ?? null,
    };
  });
}

const cursorSchema = z.object({ v: z.string().max(40), id: z.uuid() });

export async function listRuns(
  tx: TenantTx,
  ctx: CrmContext,
  workflowId: string,
  rawQuery: z.input<typeof runListQuerySchema>,
): Promise<{ data: RunSummary[]; nextCursor: string | null }> {
  const query = runListQuerySchema.parse(rawQuery);
  const [workflow] = await tx
    .select({ id: automationWorkflows.id })
    .from(automationWorkflows)
    .where(
      and(
        eq(automationWorkflows.id, workflowId),
        eq(automationWorkflows.organizationId, ctx.organizationId),
      ),
    );
  if (!workflow) throw new NotFoundError('Workflow');
  const conditions: SQL[] = [
    eq(automationRuns.organizationId, ctx.organizationId),
    eq(automationRuns.workflowId, workflowId),
  ];
  if (query.status) conditions.push(eq(automationRuns.status, query.status));
  if (query.cursor) {
    const position = decodeCursor(query.cursor, cursorSchema);
    conditions.push(
      sql`(${automationRuns.startedAt}, ${automationRuns.id}) < (${position.v}::timestamptz, ${position.id}::uuid)`,
    );
  }
  const rows = await tx
    .select({ row: automationRuns, sortValue: sql<string>`${automationRuns.startedAt}::text` })
    .from(automationRuns)
    .where(and(...conditions))
    .orderBy(desc(automationRuns.startedAt), desc(automationRuns.id))
    .limit(query.limit + 1);
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return {
    data: await runSummaries(
      tx,
      ctx,
      page.map((entry) => entry.row),
    ),
    nextCursor:
      rows.length > query.limit && last
        ? encodeCursor({ v: last.sortValue, id: last.row.id })
        : null,
  };
}

export async function getRun(tx: TenantTx, ctx: CrmContext, runId: string): Promise<RunDetail> {
  const [row] = await tx
    .select()
    .from(automationRuns)
    .where(
      and(eq(automationRuns.id, runId), eq(automationRuns.organizationId, ctx.organizationId)),
    );
  if (!row) throw new NotFoundError('Run');
  const [summary] = await runSummaries(tx, ctx, [row]);
  if (!summary) throw new NotFoundError('Run');
  const steps = await tx
    .select()
    .from(automationRunSteps)
    .where(
      and(
        eq(automationRunSteps.runId, row.id),
        eq(automationRunSteps.organizationId, ctx.organizationId),
      ),
    )
    .orderBy(asc(automationRunSteps.startedAt), asc(automationRunSteps.id));
  const logs = await tx
    .select()
    .from(automationRunLogs)
    .where(
      and(
        eq(automationRunLogs.runId, row.id),
        eq(automationRunLogs.organizationId, ctx.organizationId),
      ),
    )
    .orderBy(asc(automationRunLogs.at), asc(automationRunLogs.id))
    .limit(500);
  return {
    ...summary,
    triggerData: row.triggerData,
    steps: steps.map((step) => ({
      nodeKey: step.nodeKey,
      nodeType: step.nodeType,
      action: step.action,
      status: step.status,
      attempts: step.attempts,
      resumeAt: step.resumeAt?.toISOString() ?? null,
      output: step.output,
      error: step.error,
      startedAt: step.startedAt.toISOString(),
      finishedAt: step.finishedAt?.toISOString() ?? null,
    })),
    logs: logs.map((entry) => ({
      nodeKey: entry.nodeKey,
      level: entry.level,
      message: entry.message,
      at: entry.at.toISOString(),
    })),
  };
}
