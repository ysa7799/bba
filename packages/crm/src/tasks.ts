import {
  crmCompanies,
  crmContacts,
  crmDeals,
  crmTasks,
  TASK_PRIORITIES,
  TASK_STATUSES,
  users,
  type CrmTask,
  type TenantTx,
} from '@businessos/database';
import { emitEvent } from '@businessos/events';
import { NotFoundError, paginationQuerySchema, type Page } from '@businessos/shared';
import { and, eq, gte, isNotNull, isNull, lt, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { canRead, eventMeta, type CrmContext } from './context';
import { afterCursor, keysetPage, orderFor, sortValue, type SortSpec } from './listing';
import { assertActiveMember } from './members';
import { displayName, escapeLike, optionalText } from './normalize';
import { assertCompanyExists, assertContactExists, assertDealExists } from './records';

const taskFields = {
  description: optionalText(5_000),
  dueAt: z.iso.datetime({ offset: true }).nullable().optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  assigneeUserId: z.uuid().nullable().optional(),
  contactId: z.uuid().nullable().optional(),
  companyId: z.uuid().nullable().optional(),
  dealId: z.uuid().nullable().optional(),
};

export const createTaskInputSchema = z.object({
  title: z.string().trim().min(1).max(300),
  ...taskFields,
});
export const updateTaskInputSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  status: z.enum(TASK_STATUSES).optional(),
  ...taskFields,
});
export type CreateTaskInput = z.input<typeof createTaskInputSchema>;
export type UpdateTaskInput = z.input<typeof updateTaskInputSchema>;

export const TASK_SORTS = ['due_asc', 'created_desc'] as const;
export const TASK_DUE_FILTERS = ['overdue', 'today', 'upcoming', 'none'] as const;

export const taskListQuerySchema = paginationQuerySchema.extend({
  q: z.string().trim().max(200).optional(),
  status: z.enum(TASK_STATUSES).optional(),
  assigneeUserId: z.union([z.uuid(), z.literal('me'), z.literal('none')]).optional(),
  due: z.enum(TASK_DUE_FILTERS).optional(),
  contactId: z.uuid().optional(),
  companyId: z.uuid().optional(),
  dealId: z.uuid().optional(),
  sort: z.enum(TASK_SORTS).default('due_asc'),
});
export type TaskListQuery = z.infer<typeof taskListQuerySchema>;

export interface TaskSummary {
  id: string;
  title: string;
  description: string | null;
  dueAt: string | null;
  priority: CrmTask['priority'];
  status: CrmTask['status'];
  completedAt: string | null;
  assigneeUserId: string | null;
  assigneeName: string | null;
  contact: { id: string; name: string } | null;
  company: { id: string; name: string } | null;
  deal: { id: string; name: string } | null;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

const dueExpression = sql`coalesce(${crmTasks.dueAt}, 'infinity'::timestamptz)`;

function sortSpec(sort: (typeof TASK_SORTS)[number]): SortSpec {
  return sort === 'due_asc'
    ? { name: sort, expression: dueExpression, direction: 'asc', kind: 'timestamp' }
    : { name: sort, expression: crmTasks.createdAt, direction: 'desc', kind: 'timestamp' };
}

const taskColumns = {
  task: crmTasks,
  assigneeName: users.name,
  contactFirstName: crmContacts.firstName,
  contactLastName: crmContacts.lastName,
  contactEmail: crmContacts.email,
  contactPhone: crmContacts.phone,
  contactLive: sql<boolean>`${crmContacts.id} is not null`,
  companyName: crmCompanies.name,
  dealName: crmDeals.name,
};

function selectTasks(tx: TenantTx) {
  return tx
    .select({ ...taskColumns, id: crmTasks.id, sortValue: sortValue(sortSpec('due_asc')) })
    .from(crmTasks)
    .leftJoin(users, eq(users.id, crmTasks.assigneeUserId))
    .leftJoin(
      crmContacts,
      and(eq(crmContacts.id, crmTasks.contactId), isNull(crmContacts.deletedAt)),
    )
    .leftJoin(
      crmCompanies,
      and(eq(crmCompanies.id, crmTasks.companyId), isNull(crmCompanies.deletedAt)),
    )
    .leftJoin(crmDeals, and(eq(crmDeals.id, crmTasks.dealId), isNull(crmDeals.deletedAt)));
}

type TaskRow = Awaited<ReturnType<ReturnType<typeof selectTasks>['execute']>>[number];

function toSummary(ctx: CrmContext, row: TaskRow): TaskSummary {
  const t = row.task;
  return {
    id: t.id,
    title: t.title,
    description: t.description,
    dueAt: t.dueAt?.toISOString() ?? null,
    priority: t.priority,
    status: t.status,
    completedAt: t.completedAt?.toISOString() ?? null,
    assigneeUserId: t.assigneeUserId,
    assigneeName: t.assigneeUserId === null ? null : row.assigneeName,
    contact:
      canRead(ctx, 'contact') && t.contactId && row.contactLive
        ? {
            id: t.contactId,
            name: displayName({
              firstName: row.contactFirstName,
              lastName: row.contactLastName,
              email: row.contactEmail,
              phone: row.contactPhone,
            }),
          }
        : null,
    company:
      canRead(ctx, 'company') && t.companyId && row.companyName !== null
        ? { id: t.companyId, name: row.companyName }
        : null,
    deal:
      canRead(ctx, 'deal') && t.dealId && row.dealName !== null
        ? { id: t.dealId, name: row.dealName }
        : null,
    createdByUserId: t.createdByUserId,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

/** Start of the organization's current local day, as a timestamptz expression. */
function startOfToday(timezone: string, plusDays = 0): SQL {
  return sql`(date_trunc('day', now() at time zone ${timezone}) + make_interval(days => ${plusDays})) at time zone ${timezone}`;
}

export async function listTasks(
  tx: TenantTx,
  ctx: CrmContext,
  query: TaskListQuery,
): Promise<Page<TaskSummary>> {
  const conditions: SQL[] = [
    eq(crmTasks.organizationId, ctx.organizationId),
    isNull(crmTasks.deletedAt),
  ];
  if (query.q) conditions.push(sql`${crmTasks.title} ILIKE ${`%${escapeLike(query.q)}%`}`);
  if (query.status) conditions.push(eq(crmTasks.status, query.status));
  if (query.assigneeUserId === 'none') conditions.push(isNull(crmTasks.assigneeUserId));
  else if (query.assigneeUserId === 'me') {
    conditions.push(ctx.actor.userId ? eq(crmTasks.assigneeUserId, ctx.actor.userId) : sql`false`);
  } else if (query.assigneeUserId)
    conditions.push(eq(crmTasks.assigneeUserId, query.assigneeUserId));
  switch (query.due) {
    case 'overdue':
      conditions.push(isNotNull(crmTasks.dueAt), lt(crmTasks.dueAt, sql`now()`));
      break;
    case 'today':
      conditions.push(
        gte(crmTasks.dueAt, startOfToday(ctx.timezone)),
        lt(crmTasks.dueAt, startOfToday(ctx.timezone, 1)),
      );
      break;
    case 'upcoming':
      conditions.push(gte(crmTasks.dueAt, startOfToday(ctx.timezone, 1)));
      break;
    case 'none':
      conditions.push(isNull(crmTasks.dueAt));
      break;
    case undefined:
      break;
  }
  if (query.contactId) conditions.push(eq(crmTasks.contactId, query.contactId));
  if (query.companyId) conditions.push(eq(crmTasks.companyId, query.companyId));
  if (query.dealId) conditions.push(eq(crmTasks.dealId, query.dealId));
  const spec = sortSpec(query.sort);
  const after = afterCursor(spec, crmTasks.id, query.cursor);
  if (after) conditions.push(after);
  const rows = await tx
    .select({ ...taskColumns, id: crmTasks.id, sortValue: sortValue(spec) })
    .from(crmTasks)
    .leftJoin(users, eq(users.id, crmTasks.assigneeUserId))
    .leftJoin(
      crmContacts,
      and(eq(crmContacts.id, crmTasks.contactId), isNull(crmContacts.deletedAt)),
    )
    .leftJoin(
      crmCompanies,
      and(eq(crmCompanies.id, crmTasks.companyId), isNull(crmCompanies.deletedAt)),
    )
    .leftJoin(crmDeals, and(eq(crmDeals.id, crmTasks.dealId), isNull(crmDeals.deletedAt)))
    .where(and(...conditions))
    .orderBy(...orderFor(spec, crmTasks.id))
    .limit(query.limit + 1);
  return keysetPage(spec, rows, query.limit, (row) => toSummary(ctx, row));
}

export async function getTask(tx: TenantTx, ctx: CrmContext, id: string): Promise<TaskSummary> {
  const [row] = await selectTasks(tx).where(
    and(
      eq(crmTasks.id, id),
      eq(crmTasks.organizationId, ctx.organizationId),
      isNull(crmTasks.deletedAt),
    ),
  );
  if (!row) throw new NotFoundError('Task');
  return toSummary(ctx, row);
}

async function assertLinks(
  tx: TenantTx,
  ctx: CrmContext,
  input: {
    contactId?: string | null | undefined;
    companyId?: string | null | undefined;
    dealId?: string | null | undefined;
  },
): Promise<void> {
  if (input.contactId) await assertContactExists(tx, ctx.organizationId, input.contactId);
  if (input.companyId) await assertCompanyExists(tx, ctx.organizationId, input.companyId);
  if (input.dealId) await assertDealExists(tx, ctx.organizationId, input.dealId);
}

export async function createTask(
  tx: TenantTx,
  ctx: CrmContext,
  rawInput: CreateTaskInput,
): Promise<TaskSummary> {
  const input = createTaskInputSchema.parse(rawInput);
  await assertLinks(tx, ctx, input);
  const assigneeUserId =
    input.assigneeUserId === undefined ? ctx.actor.userId : input.assigneeUserId;
  if (assigneeUserId !== null)
    await assertActiveMember(tx, ctx.organizationId, assigneeUserId, 'assigneeUserId');
  const [task] = await tx
    .insert(crmTasks)
    .values({
      organizationId: ctx.organizationId,
      title: input.title,
      description: input.description ?? null,
      dueAt: input.dueAt ? new Date(input.dueAt) : null,
      priority: input.priority ?? 'normal',
      assigneeUserId,
      contactId: input.contactId ?? null,
      companyId: input.companyId ?? null,
      dealId: input.dealId ?? null,
      createdByUserId: ctx.actor.userId,
    })
    .returning();
  if (!task) throw new Error('task insert returned no row');
  await emitEvent(tx, {
    ...eventMeta(ctx),
    type: 'task.created',
    subject: { type: 'task', id: task.id },
    payload: { taskId: task.id, assigneeUserId },
  });
  return getTask(tx, ctx, task.id);
}

async function lockTask(tx: TenantTx, organizationId: string, id: string): Promise<CrmTask> {
  const [task] = await tx
    .select()
    .from(crmTasks)
    .where(
      and(
        eq(crmTasks.id, id),
        eq(crmTasks.organizationId, organizationId),
        isNull(crmTasks.deletedAt),
      ),
    )
    .for('update');
  if (!task) throw new NotFoundError('Task');
  return task;
}

export async function updateTask(
  tx: TenantTx,
  ctx: CrmContext,
  id: string,
  rawInput: UpdateTaskInput,
): Promise<{ before: TaskSummary; after: TaskSummary; changedFields: string[] }> {
  const input = updateTaskInputSchema.parse(rawInput);
  const current = await lockTask(tx, ctx.organizationId, id);
  const before = await getTask(tx, ctx, id);
  await assertLinks(tx, ctx, {
    contactId: input.contactId === current.contactId ? undefined : input.contactId,
    companyId: input.companyId === current.companyId ? undefined : input.companyId,
    dealId: input.dealId === current.dealId ? undefined : input.dealId,
  });
  if (input.assigneeUserId && input.assigneeUserId !== current.assigneeUserId) {
    await assertActiveMember(tx, ctx.organizationId, input.assigneeUserId, 'assigneeUserId');
  }
  const set: Partial<typeof crmTasks.$inferInsert> = {};
  const changed: string[] = [];
  const assign = <K extends keyof CrmTask>(key: K, value: CrmTask[K] | undefined) => {
    if (value === undefined) return;
    const same =
      value instanceof Date && current[key] instanceof Date
        ? value.getTime() === current[key].getTime()
        : value === current[key];
    if (!same) {
      (set as Record<string, unknown>)[key] = value;
      changed.push(key);
    }
  };
  assign('title', input.title);
  assign('description', input.description);
  assign(
    'dueAt',
    input.dueAt === undefined ? undefined : input.dueAt === null ? null : new Date(input.dueAt),
  );
  assign('priority', input.priority);
  assign('assigneeUserId', input.assigneeUserId);
  assign('contactId', input.contactId);
  assign('companyId', input.companyId);
  assign('dealId', input.dealId);
  assign('status', input.status);
  const completing = set.status === 'completed';
  if (set.status !== undefined) set.completedAt = completing ? new Date() : null;
  if (changed.length === 0) return { before, after: before, changedFields: [] };
  await tx
    .update(crmTasks)
    .set(set)
    .where(and(eq(crmTasks.id, id), eq(crmTasks.organizationId, ctx.organizationId)));
  if (completing) {
    await emitEvent(tx, {
      ...eventMeta(ctx),
      type: 'task.completed',
      subject: { type: 'task', id },
      payload: { taskId: id, completedByUserId: ctx.actor.userId },
    });
  }
  return { before, after: await getTask(tx, ctx, id), changedFields: changed };
}

export async function deleteTask(tx: TenantTx, ctx: CrmContext, id: string): Promise<TaskSummary> {
  await lockTask(tx, ctx.organizationId, id);
  const before = await getTask(tx, ctx, id);
  await tx
    .update(crmTasks)
    .set({ deletedAt: new Date() })
    .where(and(eq(crmTasks.id, id), eq(crmTasks.organizationId, ctx.organizationId)));
  return before;
}
