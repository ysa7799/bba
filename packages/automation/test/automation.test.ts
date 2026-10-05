import {
  createPlan,
  createPlanVersion,
  publishPlanVersion,
  startSubscription,
} from '@businessos/billing';
import {
  ChannelProviderRegistry,
  createConnection,
  FakeChannelProvider,
  type CommunicationsServices,
} from '@businessos/communications';
import {
  addTags,
  createContact,
  createTag,
  getContact,
  updateContact,
  type CrmContext,
} from '@businessos/crm';
import {
  automationRuns,
  crmTasks,
  messages,
  outboxEvents,
  withSystem,
  withTenant,
  type DatabaseHandle,
  type Organization,
  type TenantTx,
} from '@businessos/database';
import { loadEvent, type DomainEvent } from '@businessos/events';
import { createOrganization } from '@businessos/organizations';
import {
  ConflictError,
  EntitlementExceededError,
  NotFoundError,
  SecretBox,
  ValidationError,
} from '@businessos/shared';
import {
  createTestDatabase,
  createTestUser,
  createTestWorld,
  uniqueSuffix,
  type TestWorld,
} from '@businessos/testing';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  archiveWorkflow,
  cancelRun,
  createWorkflow,
  executeRun,
  findWorkflowByWebhookToken,
  getRun,
  getWorkflow,
  listRuns,
  listWorkflows,
  MAX_CHAIN_DEPTH,
  MAX_RUNS_PER_CONTACT_PER_HOUR,
  publishWorkflow,
  resumeDueRuns,
  retryRun,
  rotateWebhookToken,
  saveWorkflowDraft,
  setWorkflowPaused,
  startRunFromWebhook,
  startRunsForEvent,
  type AutomationServices,
  type DefinitionInput,
} from '../src';

let handle: DatabaseHandle;
let world: TestWorld;
let clock = new Date('2027-03-01T08:00:00.000Z');
const queued: { name: string; payload: Record<string, unknown>; jobId: string | undefined }[] = [];
const services: AutomationServices = {
  allowPrivateNetwork: true,
  enqueue: (name, payload, options) => {
    // Same rule as the production queue.
    if (options.jobId !== undefined && !/^[A-Za-z0-9_.-]{1,200}$/.test(options.jobId)) {
      throw new Error(`Invalid job id ${options.jobId}`);
    }
    queued.push({ name, payload, jobId: options.jobId });
    return Promise.resolve();
  },
  now: () => clock,
};
const options = { allowPrivateNetwork: true };

// A local endpoint for the webhook action: answers with the queued statuses, then 200.
let server: Server;
let endpoint = '';
const hits: { idempotencyKey: string | undefined; body: Record<string, unknown> }[] = [];
let answers: number[] = [];

beforeAll(async () => {
  handle = createTestDatabase(16);
  // The resume scheduler looks at every tenant: settle runs left by earlier test runs so they
  // cannot crowd out this run's (only automation tests create runs in the test database).
  await withSystem(handle.db, (tx) =>
    tx
      .update(automationRuns)
      .set({ status: 'cancelled', resumeAt: null })
      .where(inArray(automationRuns.status, ['running', 'waiting'])),
  );
  world = await createTestWorld(handle.db);
  server = createServer((request: IncomingMessage, response) => {
    let raw = '';
    request.on('data', (chunk: Buffer) => (raw += chunk.toString()));
    request.on('end', () => {
      hits.push({
        idempotencyKey: request.headers['idempotency-key'] as string | undefined,
        body: JSON.parse(raw) as Record<string, unknown>,
      });
      response.writeHead(answers.shift() ?? 200).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await handle.close();
});

beforeEach(() => {
  queued.length = 0;
  hits.length = 0;
  answers = [];
});

const A = () => world.orgA.organization;
const B = () => world.orgB.organization;
const aOwner = () => world.orgA.users.owner.id;
const bOwner = () => world.orgB.users.owner.id;
const minutes = (n: number) => new Date(clock.getTime() + n * 60_000);

function ctxFor(org: Organization, userId: string | null): CrmContext {
  return {
    organizationId: org.id,
    countryCode: org.countryCode,
    defaultCurrency: org.defaultCurrency,
    timezone: org.timezone,
    actor: { type: userId ? 'user' : 'system', userId },
  };
}

function inOrg<T>(
  org: Organization,
  userId: string | null,
  fn: (tx: TenantTx, ctx: CrmContext) => Promise<T>,
) {
  return withTenant(handle.db, { organizationId: org.id, userId }, (tx) =>
    fn(tx, ctxFor(org, userId)),
  );
}

async function rejects<E>(promise: Promise<unknown>, type: abstract new (...args: never[]) => E) {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(type);
  return error as E;
}

async function publish(definition: DefinitionInput, org = A(), userId = aOwner()) {
  return inOrg(org, userId, async (tx, ctx) => {
    const workflow = await createWorkflow(tx, ctx, { name: `Workflow ${uniqueSuffix()}` });
    await saveWorkflowDraft(tx, ctx, workflow.id, definition, options);
    return publishWorkflow(tx, ctx, workflow.id, options);
  });
}

/** A linear workflow: each node leads to the next. */
function linear(
  trigger: DefinitionInput['trigger'],
  nodes: DefinitionInput['nodes'],
): DefinitionInput {
  return {
    trigger,
    nodes,
    edges: nodes.slice(1).map((node, index) => ({
      from: nodes[index]?.key ?? '',
      to: node.key,
      branch: 'next' as const,
    })),
    entry: nodes[0]?.key ?? null,
  };
}

/** The newest outbox event of a type about a subject, as delivered to subscribers. */
async function eventFor(type: string, subjectId: string): Promise<DomainEvent> {
  // System scope: the outbox is not readable by tenants.
  const rows = await withSystem(handle.db, (tx) =>
    tx
      .select({ id: outboxEvents.id })
      .from(outboxEvents)
      .where(and(eq(outboxEvents.type, type), eq(outboxEvents.subjectId, subjectId)))
      .orderBy(asc(outboxEvents.occurredAt), asc(outboxEvents.id)),
  );
  const last = rows.at(-1);
  if (!last) throw new Error(`no ${type} event for ${subjectId}`);
  const event = await loadEvent(handle.db, last.id);
  if (!event) throw new Error('event not loadable');
  return event;
}

/** Executes queued run jobs until none are left (delays are honoured by the run state). */
async function drain(): Promise<void> {
  for (let guard = 0; guard < 200; guard += 1) {
    const index = queued.findIndex((job) => job.name === 'automation.run');
    if (index === -1) return;
    const [job] = queued.splice(index, 1);
    if (job) {
      await executeRun(
        handle.db,
        services,
        job.payload.organizationId as string,
        job.payload.runId as string,
      );
    }
  }
  throw new Error('runs did not settle');
}

async function runRow(org: Organization, id: string) {
  const [row] = await inOrg(org, null, (tx) =>
    tx.select().from(automationRuns).where(eq(automationRuns.id, id)),
  );
  if (!row) throw new Error('run missing');
  return row;
}

async function newContact(org = A(), userId = aOwner(), firstName = 'Layla') {
  return inOrg(org, userId, (tx, ctx) =>
    createContact(tx, ctx, { firstName, email: `c-${uniqueSuffix()}@example.com`.toLowerCase() }),
  );
}

async function tag(org = A(), name = 'Tag') {
  return inOrg(org, null, (tx) => createTag(tx, org.id, { name: `${name} ${uniqueSuffix()}` }));
}

async function tasksOf(contactId: string) {
  return inOrg(A(), null, (tx) =>
    tx.select().from(crmTasks).where(eq(crmTasks.contactId, contactId)),
  );
}

/** Org-specific trigger so workflows of other tests never react to this test's events. */
async function scopedTrigger() {
  const t = await tag();
  return { tag: t, trigger: { type: 'contact.tag_added' as const, config: { tagId: t.id } } };
}

async function tagAndDeliver(contactId: string, tagId: string, org = A()) {
  await inOrg(org, aOwner(), async (tx, ctx) => {
    const added = await addTags(tx, org.id, 'contact', [contactId], [tagId]);
    const { emitEvent } = await import('@businessos/events');
    const { eventMeta } = await import('@businessos/crm');
    for (const pair of added) {
      await emitEvent(tx, {
        ...eventMeta(ctx),
        type: 'contact.tag_added',
        subject: { type: 'contact', id: contactId },
        payload: { contactId, tagId: pair.tagId },
      });
    }
  });
  return startRunsForEvent(handle.db, services, await eventFor('contact.tag_added', contactId));
}

describe('runs: actions, durable waits, conditions', () => {
  it('runs a workflow with a two-day wait and a branch, recording every step', async () => {
    const { tag: start, trigger } = await scopedTrigger();
    const vip = await tag(A(), 'VIP');
    const workflow = await publish({
      trigger,
      nodes: [
        { key: 'tag', type: 'action', action: 'contact.add_tag', config: { tagId: vip.id } },
        { key: 'wait', type: 'wait', config: { amount: 2, unit: 'days' } },
        {
          key: 'vip',
          type: 'condition',
          config: { rules: [{ field: 'contact.tags', operator: 'has_tag', value: vip.id }] },
        },
        {
          key: 'call',
          type: 'action',
          action: 'task.create',
          label: 'Call',
          config: {
            title: 'Call {{contact.firstName}}',
            dueInDays: 1,
            assignee: 'user',
            userId: world.orgA.users.sales.id,
          },
        },
        {
          key: 'demote',
          type: 'action',
          action: 'contact.update',
          config: { lifecycleStage: 'other' },
        },
      ],
      edges: [
        { from: 'tag', to: 'wait', branch: 'next' },
        { from: 'wait', to: 'vip', branch: 'next' },
        { from: 'vip', to: 'call', branch: 'true' },
        { from: 'vip', to: 'demote', branch: 'false' },
      ],
      entry: 'tag',
    });
    const contact = await newContact();
    const [runId] = await tagAndDeliver(contact.id, start.id);
    if (!runId) throw new Error('no run');
    await drain();

    let run = await runRow(A(), runId);
    expect(run).toMatchObject({ status: 'waiting', currentNodeKey: 'wait', contactId: contact.id });
    expect(run.resumeAt?.toISOString()).toBe(minutes(2 * 24 * 60).toISOString());
    const tagged = await inOrg(A(), null, (tx, ctx) => getContact(tx, ctx, contact.id));
    expect(tagged.tags.map((t) => t.id)).toContain(vip.id);
    // Nothing happens before the wait is over, even if a job runs early.
    expect(await executeRun(handle.db, services, A().id, runId)).toBe('waiting');
    expect(await tasksOf(contact.id)).toHaveLength(0);

    // Two days later the scheduler picks the run up from the database.
    clock = minutes(2 * 24 * 60 + 1);
    queued.length = 0;
    expect((await resumeDueRuns(handle.db, services)).queued).toBeGreaterThanOrEqual(1);
    await drain();
    run = await runRow(A(), runId);
    expect(run.status).toBe('completed');
    const tasks = await tasksOf(contact.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      title: 'Call Layla',
      assigneeUserId: world.orgA.users.sales.id,
    });

    const detail = await inOrg(A(), aOwner(), (tx, ctx) => getRun(tx, ctx, runId));
    expect(detail.steps.map((step) => [step.nodeKey, step.status])).toEqual([
      ['tag', 'succeeded'],
      ['wait', 'succeeded'],
      ['vip', 'succeeded'],
      ['call', 'succeeded'],
    ]);
    expect(detail.steps[2]?.output).toEqual({ result: true, branch: 'true' });
    expect(detail.logs.map((entry) => entry.message)).toEqual(
      expect.arrayContaining(['Started by contact.tag_added', 'Condition is true', 'Completed']),
    );
    // Changes made by a run are attributed to the workflow and carry the run's correlation id.
    const tagEvent = await eventFor('contact.tag_added', contact.id);
    expect(tagEvent.actor).toEqual({ type: 'workflow', id: workflow.id });
    expect(tagEvent.correlationId).toBe(`automation:${runId}`);
    const started = await eventFor('workflow.started', runId);
    const completed = await eventFor('workflow.completed', runId);
    expect(started.payload).toMatchObject({
      workflowId: workflow.id,
      triggerType: 'contact.tag_added',
    });
    expect(completed.payload).toEqual({ workflowId: workflow.id, runId });
  });

  it('keeps runs in progress on the version they started with', async () => {
    const { tag: start, trigger } = await scopedTrigger();
    const workflow = await publish(
      linear(trigger, [
        { key: 'wait', type: 'wait', config: { amount: 1, unit: 'hours' } },
        { key: 'task', type: 'action', action: 'task.create', config: { title: 'Version one' } },
      ]),
    );
    const contact = await newContact();
    const [runId] = await tagAndDeliver(contact.id, start.id);
    await drain();
    await inOrg(A(), aOwner(), async (tx, ctx) => {
      await saveWorkflowDraft(
        tx,
        ctx,
        workflow.id,
        linear(trigger, [
          { key: 'task', type: 'action', action: 'task.create', config: { title: 'Version two' } },
        ]),
        options,
      );
      await publishWorkflow(tx, ctx, workflow.id, options);
    });
    clock = minutes(61);
    await resumeDueRuns(handle.db, services);
    await drain();
    expect((await runRow(A(), runId ?? '')).status).toBe('completed');
    expect((await tasksOf(contact.id)).map((task) => task.title)).toEqual(['Version one']);
  });
});

describe('quality gate: duplicate events and idempotency', () => {
  it('starts one run per event however often and however concurrently it is delivered', async () => {
    const { tag: start, trigger } = await scopedTrigger();
    await publish(
      linear(trigger, [
        { key: 'task', type: 'action', action: 'task.create', config: { title: 'Once' } },
      ]),
    );
    const contact = await newContact();
    const [first] = await tagAndDeliver(contact.id, start.id);
    const event = await eventFor('contact.tag_added', contact.id);
    const again = await Promise.all(
      Array.from({ length: 5 }, () => startRunsForEvent(handle.db, services, event)),
    );
    expect(new Set(again.flat())).toEqual(new Set([first]));
    await drain();
    const runs = await inOrg(A(), null, (tx) =>
      tx.select().from(automationRuns).where(eq(automationRuns.contactId, contact.id)),
    );
    expect(runs).toHaveLength(1);
    expect(await tasksOf(contact.id)).toHaveLength(1);
  });

  it('performs each step once even when the same run is executed concurrently', async () => {
    const { tag: start, trigger } = await scopedTrigger();
    await publish(
      linear(trigger, [
        { key: 'task', type: 'action', action: 'task.create', config: { title: 'Exactly once' } },
        { key: 'hook', type: 'action', action: 'http.request', config: { url: endpoint } },
      ]),
    );
    const contact = await newContact();
    const [runId] = await tagAndDeliver(contact.id, start.id);
    queued.length = 0;
    await Promise.all(
      Array.from({ length: 6 }, () => executeRun(handle.db, services, A().id, runId ?? '')),
    );
    await drain();
    // A crashed or duplicate job re-running a finished run changes nothing.
    await executeRun(handle.db, services, A().id, runId ?? '');
    expect((await runRow(A(), runId ?? '')).status).toBe('completed');
    expect(await tasksOf(contact.id)).toHaveLength(1);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.idempotencyKey).toBe(`${runId}:hook`);
  });
});

describe('quality gate: retries, failures and timeouts', () => {
  it('retries transient failures with backoff using the same idempotency key', async () => {
    const { tag: start, trigger } = await scopedTrigger();
    await publish(
      linear(trigger, [
        { key: 'hook', type: 'action', action: 'http.request', config: { url: endpoint } },
      ]),
    );
    answers = [503, 500];
    const contact = await newContact();
    const [runId = ''] = await tagAndDeliver(contact.id, start.id);
    await drain();
    let run = await runRow(A(), runId);
    expect(run.status).toBe('waiting');
    expect(run.resumeAt?.toISOString()).toBe(minutes(1).toISOString());

    clock = minutes(1);
    await resumeDueRuns(handle.db, services);
    await drain();
    run = await runRow(A(), runId);
    expect(run.resumeAt?.toISOString()).toBe(minutes(5).toISOString());

    clock = minutes(5);
    await resumeDueRuns(handle.db, services);
    await drain();
    expect((await runRow(A(), runId)).status).toBe('completed');
    expect(hits.map((hit) => hit.idempotencyKey)).toEqual([
      `${runId}:hook`,
      `${runId}:hook`,
      `${runId}:hook`,
    ]);
    expect(hits[0]?.body).toMatchObject({ runId, contact: { id: contact.id, firstName: 'Layla' } });
    const detail = await inOrg(A(), aOwner(), (tx, ctx) => getRun(tx, ctx, runId));
    expect(detail.steps[0]).toMatchObject({ status: 'succeeded', attempts: 3 });
  });

  it('fails after the last attempt and on permanent errors; failed runs can be retried', async () => {
    const { tag: start, trigger } = await scopedTrigger();
    const workflow = await publish(
      linear(trigger, [
        {
          key: 'task',
          type: 'action',
          action: 'task.create',
          config: { title: 'Before the hook' },
        },
        { key: 'hook', type: 'action', action: 'http.request', config: { url: endpoint } },
      ]),
    );
    answers = [503, 503, 503, 503];
    const contact = await newContact();
    const [runId = ''] = await tagAndDeliver(contact.id, start.id);
    await drain();
    for (const delay of [1, 5, 30]) {
      clock = minutes(delay);
      await resumeDueRuns(handle.db, services);
      await drain();
    }
    let run = await runRow(A(), runId);
    expect(run.status).toBe('failed');
    expect(run.error).toContain('The endpoint answered 503');
    expect(hits).toHaveLength(4);
    expect((await eventFor('workflow.failed', runId)).payload).toMatchObject({
      workflowId: workflow.id,
    });

    // A permanent error (4xx) fails at once.
    answers = [422];
    const other = await newContact();
    const [permanentId = ''] = await tagAndDeliver(other.id, start.id);
    await drain();
    expect((await runRow(A(), permanentId)).status).toBe('failed');

    // Manual retry resumes at the failed step: the task is not created twice.
    await inOrg(A(), aOwner(), (tx, ctx) => retryRun(tx, ctx, runId));
    await executeRun(handle.db, services, A().id, runId);
    run = await runRow(A(), runId);
    expect(run.status).toBe('completed');
    expect(await tasksOf(contact.id)).toHaveLength(1);
    await rejects(
      inOrg(A(), aOwner(), (tx, ctx) => retryRun(tx, ctx, runId)),
      ConflictError,
    );
  });

  it('fails runs that outlive their deadline and steps that need a missing subject', async () => {
    const workflow = await publish(
      linear({ type: 'webhook.received', config: {} }, [
        {
          key: 'tag',
          type: 'action',
          action: 'contact.add_tag',
          config: { tagId: (await tag()).id },
        },
      ]),
    );
    const { token } = await inOrg(A(), aOwner(), (tx, ctx) =>
      rotateWebhookToken(tx, ctx, workflow.id),
    );
    const target = await findWorkflowByWebhookToken(handle.db, token);
    if (!target) throw new Error('token not found');
    const { runId } = await startRunFromWebhook(
      handle.db,
      services,
      target,
      { hello: 'world' },
      `d-${uniqueSuffix()}`,
    );
    await drain();
    const run = await runRow(A(), runId);
    expect(run.status).toBe('failed');
    expect(run.error).toContain('needs a contact');

    const late = await startRunFromWebhook(handle.db, services, target, {}, `d-${uniqueSuffix()}`);
    await inOrg(A(), null, (tx) =>
      tx
        .update(automationRuns)
        .set({ deadlineAt: minutes(-1) })
        .where(eq(automationRuns.id, late.runId)),
    );
    await drain();
    expect((await runRow(A(), late.runId)).error).toContain('Timed out');
  });
});

describe('workflow lifecycle', () => {
  it('pauses (nothing starts or continues) and resumes; archiving cancels runs', async () => {
    const { tag: start, trigger } = await scopedTrigger();
    const workflow = await publish(
      linear(trigger, [
        { key: 'wait', type: 'wait', config: { amount: 1, unit: 'hours' } },
        { key: 'task', type: 'action', action: 'task.create', config: { title: 'After resume' } },
      ]),
    );
    const contact = await newContact();
    const [runId = ''] = await tagAndDeliver(contact.id, start.id);
    await drain();
    await inOrg(A(), aOwner(), (tx, ctx) => setWorkflowPaused(tx, ctx, workflow.id, true));
    const other = await newContact();
    expect(await tagAndDeliver(other.id, start.id)).toEqual([]);
    clock = minutes(120);
    queued.length = 0;
    await resumeDueRuns(handle.db, services);
    expect(queued.some((job) => job.payload.runId === runId)).toBe(false);
    expect(await executeRun(handle.db, services, A().id, runId)).toBe('paused');
    expect(await tasksOf(contact.id)).toHaveLength(0);

    await inOrg(A(), aOwner(), (tx, ctx) => setWorkflowPaused(tx, ctx, workflow.id, false));
    await resumeDueRuns(handle.db, services);
    await drain();
    expect((await runRow(A(), runId)).status).toBe('completed');
    expect(await tasksOf(contact.id)).toHaveLength(1);

    const waiting = await newContact();
    const [waitingRun = ''] = await tagAndDeliver(waiting.id, start.id);
    await drain();
    const archived = await inOrg(A(), aOwner(), (tx, ctx) => archiveWorkflow(tx, ctx, workflow.id));
    expect(archived.cancelledRuns).toBe(1);
    expect((await runRow(A(), waitingRun)).status).toBe('cancelled');
    const list = await inOrg(A(), null, (tx) => listWorkflows(tx, A().id));
    expect(list.data.map((entry) => entry.id)).not.toContain(workflow.id);
  });

  it('enforces automation.workflows.max (also concurrently) and the monthly run quota', async () => {
    const owner = await createTestUser(handle.db, { name: 'Limited owner' });
    const { organization } = await createOrganization(handle.db, owner.id, {
      name: `Automation limits ${uniqueSuffix()}`,
    });
    await withSystem(handle.db, async (tx) => {
      const plan = await createPlan(tx, {
        key: `auto-${uniqueSuffix()}`,
        name: 'Limited',
        isPublic: false,
      });
      const version = await createPlanVersion(tx, plan.id, {
        'automation.workflows.max': 1,
        'automation.monthly_executions': 2,
      });
      await publishPlanVersion(tx, version.id);
      await startSubscription(tx, {
        organizationId: organization.id,
        planVersionId: version.id,
        status: 'active',
        provider: 'manual',
      });
    });
    const t = await tag(organization);
    const definition = linear({ type: 'contact.tag_added', config: { tagId: t.id } }, [
      { key: 'task', type: 'action', action: 'task.create', config: { title: 'Quota' } },
    ]);
    const drafts = await Promise.all(
      [1, 2].map(() =>
        inOrg(organization, owner.id, async (tx, ctx) => {
          const workflow = await createWorkflow(tx, ctx, { name: 'Limited' });
          await saveWorkflowDraft(tx, ctx, workflow.id, definition, options);
          return workflow;
        }),
      ),
    );
    const results = await Promise.allSettled(
      drafts.map((draft) =>
        inOrg(organization, owner.id, (tx, ctx) => publishWorkflow(tx, ctx, draft.id, options)),
      ),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')?.reason).toBeInstanceOf(
      EntitlementExceededError,
    );

    const outcomes: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const contact = await newContact(organization, owner.id);
      await tagAndDeliver(contact.id, t.id, organization);
      const [run] = await inOrg(organization, null, (tx) =>
        tx.select().from(automationRuns).where(eq(automationRuns.contactId, contact.id)),
      );
      outcomes.push(`${run?.status}:${run?.error ?? ''}`);
    }
    expect(outcomes.slice(0, 2)).toEqual(['running:', 'running:']);
    expect(outcomes[2]).toBe('skipped:The monthly workflow run limit of the plan is reached');
  });
});

describe('quality gate: loop protection', () => {
  it('stops chains of workflows starting each other beyond the maximum depth', async () => {
    const tags = await Promise.all(
      Array.from({ length: MAX_CHAIN_DEPTH + 3 }, (_, i) => tag(A(), `Chain${i}`)),
    );
    const workflows = [];
    for (let i = 0; i < MAX_CHAIN_DEPTH + 2; i += 1) {
      workflows.push(
        await publish(
          linear({ type: 'contact.tag_added', config: { tagId: tags[i]?.id } }, [
            {
              key: 'next',
              type: 'action',
              action: 'contact.add_tag',
              config: { tagId: tags[i + 1]?.id },
            },
          ]),
        ),
      );
    }
    const contact = await newContact();
    await tagAndDeliver(contact.id, tags[0]?.id ?? '');
    // Deliver each event caused by a run, like the outbox dispatcher would.
    for (let i = 0; i < MAX_CHAIN_DEPTH + 2; i += 1) {
      await drain();
      await startRunsForEvent(handle.db, services, await eventFor('contact.tag_added', contact.id));
    }
    await drain();
    const runs = await inOrg(A(), null, (tx) =>
      tx
        .select()
        .from(automationRuns)
        .where(eq(automationRuns.contactId, contact.id))
        .orderBy(asc(automationRuns.depth)),
    );
    expect(runs.map((run) => [run.depth, run.status])).toEqual([
      [0, 'completed'],
      [1, 'completed'],
      [2, 'completed'],
      [3, 'completed'],
      [4, 'skipped'],
    ]);
    expect(runs[4]?.error).toContain('Loop protection');
    const final = await inOrg(A(), null, (tx, ctx) => getContact(tx, ctx, contact.id));
    expect(final.tags.map((t) => t.id)).not.toContain(tags[MAX_CHAIN_DEPTH + 2]?.id);
  });

  it("never lets a workflow's own changes start it again, and caps runs per contact", async () => {
    const self = await publish(
      linear({ type: 'contact.updated', config: { fields: ['jobTitle'] } }, [
        {
          key: 'touch',
          type: 'action',
          action: 'contact.update',
          config: { jobTitle: '{{contact.jobTitle}}!' },
        },
      ]),
    );
    const contact = await newContact();
    await inOrg(A(), aOwner(), (tx, ctx) =>
      updateContact(tx, ctx, contact.id, { jobTitle: 'Buyer' }),
    );
    await startRunsForEvent(handle.db, services, await eventFor('contact.updated', contact.id));
    await drain();
    await startRunsForEvent(handle.db, services, await eventFor('contact.updated', contact.id));
    await drain();
    const after = await inOrg(A(), null, (tx, ctx) => getContact(tx, ctx, contact.id));
    expect(after.jobTitle).toBe('Buyer!');
    const runs = await inOrg(A(), null, (tx) =>
      tx.select().from(automationRuns).where(eq(automationRuns.workflowId, self.id)),
    );
    expect(runs.map((run) => run.status).sort()).toEqual(['completed', 'skipped']);
    await inOrg(A(), aOwner(), (tx, ctx) => archiveWorkflow(tx, ctx, self.id));

    // People (not workflows) changing a contact over and over: capped per hour.
    const { tag: start, trigger } = await scopedTrigger();
    const capped = await publish(
      linear(trigger, [{ key: 'wait', type: 'wait', config: { amount: 1, unit: 'minutes' } }]),
    );
    const busy = await newContact();
    for (let i = 0; i <= MAX_RUNS_PER_CONTACT_PER_HOUR; i += 1) {
      await inOrg(A(), aOwner(), async (tx) => {
        const { removeTags } = await import('@businessos/crm');
        await removeTags(tx, A().id, 'contact', [busy.id], [start.id]);
      });
      await tagAndDeliver(busy.id, start.id);
    }
    const cappedRuns = await inOrg(A(), aOwner(), (tx, ctx) =>
      listRuns(tx, ctx, capped.id, { limit: 100 }),
    );
    expect(cappedRuns.data.filter((run) => run.status === 'skipped')).toHaveLength(1);
    expect(cappedRuns.data.find((run) => run.status === 'skipped')?.error).toContain(
      'within an hour',
    );
  });
});

describe('inbound webhooks and messages', () => {
  it('starts runs from a webhook once per delivery and creates the contact from the payload', async () => {
    const vip = await tag(A(), 'Webhook');
    const workflow = await publish(
      linear({ type: 'webhook.received', config: {} }, [
        {
          key: 'contact',
          type: 'action',
          action: 'contact.create',
          config: { firstName: '{{trigger.body.name}}', email: '{{trigger.body.email}}' },
        },
        { key: 'tag', type: 'action', action: 'contact.add_tag', config: { tagId: vip.id } },
      ]),
    );
    const { token } = await inOrg(A(), aOwner(), (tx, ctx) =>
      rotateWebhookToken(tx, ctx, workflow.id),
    );
    const target = await findWorkflowByWebhookToken(handle.db, token);
    expect(target).toEqual({ organizationId: A().id, workflowId: workflow.id });
    if (!target) throw new Error('missing');
    const email = `hook-${uniqueSuffix()}@example.com`.toLowerCase();
    const first = await startRunFromWebhook(
      handle.db,
      services,
      target,
      { name: 'Noor', email },
      'delivery-1',
    );
    const again = await startRunFromWebhook(
      handle.db,
      services,
      target,
      { name: 'Noor', email },
      'delivery-1',
    );
    expect(again).toEqual({ runId: first.runId, duplicate: true });
    await drain();
    const run = await runRow(A(), first.runId);
    expect(run.status).toBe('completed');
    const contact = await inOrg(A(), null, (tx, ctx) => getContact(tx, ctx, run.contactId ?? ''));
    expect(contact).toMatchObject({ firstName: 'Noor', email, source: 'automation' });
    expect(contact.tags.map((t) => t.id)).toEqual([vip.id]);

    // Rotating invalidates the old token.
    await inOrg(A(), aOwner(), (tx, ctx) => rotateWebhookToken(tx, ctx, workflow.id));
    expect(await findWorkflowByWebhookToken(handle.db, token)).toBeNull();
    expect(await findWorkflowByWebhookToken(handle.db, 'short')).toBeNull();
  });

  it('queues messages through the channel and delivers them with a job', async () => {
    const communications: CommunicationsServices = {
      providers: new ChannelProviderRegistry([new FakeChannelProvider('email')]),
      secretBox: new SecretBox([{ id: 'test', key: randomBytes(32) }]),
      publicApiUrl: 'https://api.test',
    };
    const { connection } = await inOrg(A(), aOwner(), (tx, ctx) =>
      createConnection(tx, ctx, communications, {
        provider: 'fake_email',
        name: `Mail ${uniqueSuffix()}`,
        address: `team-${uniqueSuffix()}@example.com`.toLowerCase(),
      }),
    );
    const { tag: start, trigger } = await scopedTrigger();
    await publish(
      linear(trigger, [
        {
          key: 'welcome',
          type: 'action',
          action: 'message.email',
          config: {
            connectionId: connection.id,
            subject: 'Welcome {{contact.firstName}}',
            body: 'Hello {{contact.fullName}}, thanks for your interest.',
          },
        },
      ]),
    );
    const contact = await newContact(A(), aOwner(), 'Huda');
    await tagAndDeliver(contact.id, start.id);
    await drain();
    const job = queued.find((entry) => entry.name === 'communications.send');
    expect(job?.jobId).toBe(`msg-${job?.payload.messageId as string}`);
    const [message] = await inOrg(A(), null, (tx) =>
      tx
        .select()
        .from(messages)
        .where(eq(messages.id, (job?.payload.messageId as string | undefined) ?? '')),
    );
    expect(message).toMatchObject({
      status: 'queued',
      direction: 'outbound',
      subject: 'Welcome Huda',
      authorUserId: null,
    });
    expect(message?.bodyText).toContain('Hello Huda');
  });
});

describe('tenant isolation', () => {
  it('never reads, changes, references or triggers across organizations', async () => {
    const { tag: start, trigger } = await scopedTrigger();
    const workflow = await publish(
      linear(trigger, [{ key: 'wait', type: 'wait', config: { amount: 1, unit: 'hours' } }]),
    );
    const contact = await newContact();
    const [runId = ''] = await tagAndDeliver(contact.id, start.id);
    await drain();
    const asB = <T>(fn: (tx: TenantTx, ctx: CrmContext) => Promise<T>) => inOrg(B(), bOwner(), fn);

    await rejects(
      asB((tx) => getWorkflow(tx, B().id, workflow.id)),
      NotFoundError,
    );
    await rejects(
      asB((tx) => getWorkflow(tx, A().id, workflow.id)),
      NotFoundError,
    );
    expect((await asB((tx) => listWorkflows(tx, B().id))).data.map((w) => w.id)).not.toContain(
      workflow.id,
    );
    await rejects(
      asB((tx, ctx) => saveWorkflowDraft(tx, ctx, workflow.id, linear(trigger, []), options)),
      NotFoundError,
    );
    await rejects(
      asB((tx, ctx) => publishWorkflow(tx, ctx, workflow.id, options)),
      NotFoundError,
    );
    await rejects(
      asB((tx, ctx) => setWorkflowPaused(tx, ctx, workflow.id, true)),
      NotFoundError,
    );
    await rejects(
      asB((tx, ctx) => archiveWorkflow(tx, ctx, workflow.id)),
      NotFoundError,
    );
    await rejects(
      asB((tx, ctx) => rotateWebhookToken(tx, ctx, workflow.id)),
      NotFoundError,
    );
    await rejects(
      asB((tx, ctx) => listRuns(tx, ctx, workflow.id, {})),
      NotFoundError,
    );
    await rejects(
      asB((tx, ctx) => getRun(tx, ctx, runId)),
      NotFoundError,
    );
    await rejects(
      asB((tx, ctx) => cancelRun(tx, ctx, runId)),
      NotFoundError,
    );
    await rejects(
      asB((tx, ctx) => retryRun(tx, ctx, runId)),
      NotFoundError,
    );
    // B's executor cannot drive A's run either.
    expect(await executeRun(handle.db, services, B().id, runId)).toBe('busy');

    // A workflow in B cannot point at A's records.
    const bWorkflow = await asB((tx, ctx) => createWorkflow(tx, ctx, { name: 'B' }));
    const foreign = await rejects(
      asB((tx, ctx) =>
        saveWorkflowDraft(
          tx,
          ctx,
          bWorkflow.id,
          linear(trigger, [
            { key: 'tag', type: 'action', action: 'contact.add_tag', config: { tagId: start.id } },
            {
              key: 'owner',
              type: 'action',
              action: 'contact.assign_owner',
              config: { userId: aOwner() },
            },
          ]),
          options,
        ),
      ),
      ValidationError,
    );
    expect(foreign.details?.map((detail) => detail.path).sort()).toEqual([
      'nodes.0.config.tagId',
      'nodes.1.config.userId',
      'trigger.config.tagId',
    ]);

    // B's events never start A's workflows, even for the same kind of trigger.
    const bContact = await newContact(B(), bOwner());
    await inOrg(B(), bOwner(), (tx, ctx) =>
      updateContact(tx, ctx, bContact.id, { jobTitle: 'B buyer' }),
    );
    const bEvent = await eventFor('contact.updated', bContact.id);
    const bRuns = await startRunsForEvent(handle.db, services, bEvent);
    const aRuns = await inOrg(A(), null, (tx) =>
      tx.select().from(automationRuns).where(eq(automationRuns.sourceEventId, bEvent.id)),
    );
    expect(aRuns).toHaveLength(0);
    expect(bRuns).toEqual([]);
    await rejects(
      inOrg(A(), aOwner(), (tx, ctx) => cancelRun(tx, ctx, runId)).then(() =>
        inOrg(A(), aOwner(), (tx, ctx) => cancelRun(tx, ctx, runId)),
      ),
      ConflictError,
    );
  });
});
