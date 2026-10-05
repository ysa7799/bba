import {
  crmCompanies,
  crmContacts,
  crmDeals,
  crmDealTags,
  crmPipelines,
  crmPipelineStages,
  users,
  type CrmDeal,
  type CrmPipelineStage,
  type TenantTx,
} from '@businessos/database';
import { emitEvent } from '@businessos/events';
import {
  currencyCodeSchema,
  isCurrencyCode,
  money,
  moneyInputSchema,
  NotFoundError,
  paginationQuerySchema,
  toMoneyJson,
  ValidationError,
  type MoneyJson,
  type Page,
} from '@businessos/shared';
import { and, asc, count, eq, gt, inArray, isNull, lt, ne, sql, type SQL } from 'drizzle-orm';
import type { SelectedFields } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { canRead, eventMeta, type CrmContext } from './context';
import { CustomFieldSet, type ApiCustomValues } from './custom-fields';
import { afterCursor, keysetPage, orderFor, sortValue, type SortSpec } from './listing';
import { assertActiveMember } from './members';
import { displayName, optionalText } from './normalize';
import { defaultPipeline, getPipeline, resolveStage, type StageSummary } from './pipelines';
import { assertCompanyExists, assertContactExists, MAX_BULK_IDS } from './records';
import { searchCondition } from './search';
import {
  addTags,
  removeTags,
  setRecordTags,
  tagIdsSchema,
  tagsForRecords,
  type TagSummary,
} from './tags';

const POSITION_GAP = 1024;
const MIN_POSITION_GAP = 1e-6;

const dealValueSchema = moneyInputSchema.refine((value) => value.amountMinor >= 0n, {
  message: 'Deal value cannot be negative',
  path: ['amount'],
});

const dateSchema = z.iso.date();

const dealFields = {
  contactId: z.uuid().nullable().optional(),
  companyId: z.uuid().nullable().optional(),
  ownerUserId: z.uuid().nullable().optional(),
  value: dealValueSchema.nullable().optional(),
  /** Currency for a deal without a value yet (defaults to the organization currency). */
  currency: currencyCodeSchema.optional(),
  /** Overrides the stage probability; null returns to the stage default. */
  probability: z.number().int().min(0).max(100).nullable().optional(),
  expectedCloseDate: dateSchema.nullable().optional(),
  lostReason: optionalText(500),
  customFields: z
    .record(z.string().max(60), z.unknown())
    .refine((value) => Object.keys(value).length <= 100, { message: 'Too many custom fields' })
    .optional(),
  tagIds: tagIdsSchema.optional(),
};

export const createDealInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  pipelineId: z.uuid().optional(),
  stageId: z.uuid().optional(),
  ...dealFields,
});
export const updateDealInputSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  pipelineId: z.uuid().optional(),
  stageId: z.uuid().optional(),
  ...dealFields,
});
export const moveDealInputSchema = z.object({
  stageId: z.uuid(),
  pipelineId: z.uuid().optional(),
  /** Place directly after this deal (it ends up above the moved deal). */
  afterDealId: z.uuid().nullable().optional(),
  /** Place directly before this deal. */
  beforeDealId: z.uuid().nullable().optional(),
  lostReason: optionalText(500),
});
export type CreateDealInput = z.input<typeof createDealInputSchema>;
export type UpdateDealInput = z.input<typeof updateDealInputSchema>;
export type MoveDealInput = z.input<typeof moveDealInputSchema>;

export const DEAL_SORTS = [
  'created_desc',
  'created_asc',
  'updated_desc',
  'name_asc',
  'close_date_asc',
] as const;

export const dealListQuerySchema = paginationQuerySchema.extend({
  q: z.string().trim().max(200).optional(),
  pipelineId: z.uuid().optional(),
  stageId: z.uuid().optional(),
  status: z.enum(['open', 'won', 'lost']).optional(),
  ownerUserId: z.union([z.uuid(), z.literal('me'), z.literal('none')]).optional(),
  contactId: z.uuid().optional(),
  companyId: z.uuid().optional(),
  tagId: z.uuid().optional(),
  sort: z.enum(DEAL_SORTS).default('created_desc'),
});
export type DealListQuery = z.infer<typeof dealListQuerySchema> & {
  customFields?: Record<string, string> | undefined;
};

export interface DealSummary {
  id: string;
  name: string;
  pipelineId: string;
  pipelineName: string;
  stageId: string;
  stageName: string;
  status: CrmDeal['status'];
  contact: { id: string; name: string } | null;
  company: { id: string; name: string } | null;
  ownerUserId: string | null;
  ownerName: string | null;
  value: MoneyJson | null;
  currency: string;
  /** Effective probability (deal override or stage default). */
  probability: number;
  probabilityOverride: number | null;
  expectedCloseDate: string | null;
  closedAt: string | null;
  lostReason: string | null;
  stageEnteredAt: string;
  position: number;
  tags: TagSummary[];
  customFields: ApiCustomValues;
  createdAt: string;
  updatedAt: string;
}

const closeDateExpression = sql`coalesce(${crmDeals.expectedCloseDate}, 'infinity'::date)`;

function sortSpec(sort: (typeof DEAL_SORTS)[number]): SortSpec {
  switch (sort) {
    case 'created_desc':
      return { name: sort, expression: crmDeals.createdAt, direction: 'desc', kind: 'timestamp' };
    case 'created_asc':
      return { name: sort, expression: crmDeals.createdAt, direction: 'asc', kind: 'timestamp' };
    case 'updated_desc':
      return { name: sort, expression: crmDeals.updatedAt, direction: 'desc', kind: 'timestamp' };
    case 'name_asc':
      return {
        name: sort,
        expression: sql`lower(${crmDeals.name})`,
        direction: 'asc',
        kind: 'text',
      };
    case 'close_date_asc':
      return { name: sort, expression: closeDateExpression, direction: 'asc', kind: 'date' };
  }
}

const dealColumns = {
  deal: crmDeals,
  pipelineName: crmPipelines.name,
  stageName: crmPipelineStages.name,
  stageProbability: crmPipelineStages.probability,
  ownerName: users.name,
  contactFirstName: crmContacts.firstName,
  contactLastName: crmContacts.lastName,
  contactEmail: crmContacts.email,
  contactPhone: crmContacts.phone,
  companyName: crmCompanies.name,
};

type DealRow = {
  deal: CrmDeal;
  pipelineName: string;
  stageName: string;
  stageProbability: number;
  ownerName: string | null;
  contactFirstName: string | null;
  contactLastName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  companyName: string | null;
};

function selectDeals<T extends SelectedFields>(tx: TenantTx, extra: T) {
  return tx
    .select({ ...dealColumns, ...extra })
    .from(crmDeals)
    .innerJoin(crmPipelines, eq(crmPipelines.id, crmDeals.pipelineId))
    .innerJoin(crmPipelineStages, eq(crmPipelineStages.id, crmDeals.stageId))
    .leftJoin(users, eq(users.id, crmDeals.ownerUserId))
    .leftJoin(
      crmContacts,
      and(eq(crmContacts.id, crmDeals.contactId), isNull(crmContacts.deletedAt)),
    )
    .leftJoin(
      crmCompanies,
      and(eq(crmCompanies.id, crmDeals.companyId), isNull(crmCompanies.deletedAt)),
    );
}

function dealValue(deal: CrmDeal): MoneyJson | null {
  if (deal.valueMinor === null || !isCurrencyCode(deal.currency)) return null;
  return toMoneyJson(money(deal.valueMinor, deal.currency));
}

function toSummary(
  ctx: CrmContext,
  row: DealRow,
  fields: CustomFieldSet,
  tags: Map<string, TagSummary[]>,
): DealSummary {
  const d = row.deal;
  const contactVisible =
    canRead(ctx, 'contact') &&
    d.contactId !== null &&
    (row.contactFirstName ?? row.contactLastName ?? row.contactEmail ?? row.contactPhone) !== null;
  return {
    id: d.id,
    name: d.name,
    pipelineId: d.pipelineId,
    pipelineName: row.pipelineName,
    stageId: d.stageId,
    stageName: row.stageName,
    status: d.status,
    contact:
      contactVisible && d.contactId
        ? {
            id: d.contactId,
            name: displayName({
              firstName: row.contactFirstName,
              lastName: row.contactLastName,
              email: row.contactEmail,
              phone: row.contactPhone,
            }),
          }
        : null,
    company:
      canRead(ctx, 'company') && d.companyId && row.companyName !== null
        ? { id: d.companyId, name: row.companyName }
        : null,
    ownerUserId: d.ownerUserId,
    ownerName: d.ownerUserId === null ? null : row.ownerName,
    value: dealValue(d),
    currency: d.currency,
    probability: d.probability ?? row.stageProbability,
    probabilityOverride: d.probability,
    expectedCloseDate: d.expectedCloseDate,
    closedAt: d.closedAt?.toISOString() ?? null,
    lostReason: d.lostReason,
    stageEnteredAt: d.stageEnteredAt.toISOString(),
    position: d.position,
    tags: tags.get(d.id) ?? [],
    customFields: fields.toApi(d.customFields),
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
  };
}

export async function dealFilterConditions(
  tx: TenantTx,
  ctx: CrmContext,
  query: Omit<DealListQuery, 'limit' | 'cursor' | 'sort'>,
  fields?: CustomFieldSet,
): Promise<SQL[]> {
  const conditions: SQL[] = [
    eq(crmDeals.organizationId, ctx.organizationId),
    isNull(crmDeals.deletedAt),
  ];
  if (query.q) {
    const search = searchCondition(crmDeals.searchVector, query.q);
    if (search) conditions.push(search);
  }
  if (query.pipelineId) conditions.push(eq(crmDeals.pipelineId, query.pipelineId));
  if (query.stageId) conditions.push(eq(crmDeals.stageId, query.stageId));
  if (query.status) conditions.push(eq(crmDeals.status, query.status));
  if (query.ownerUserId === 'none') conditions.push(isNull(crmDeals.ownerUserId));
  else if (query.ownerUserId === 'me') {
    conditions.push(ctx.actor.userId ? eq(crmDeals.ownerUserId, ctx.actor.userId) : sql`false`);
  } else if (query.ownerUserId) conditions.push(eq(crmDeals.ownerUserId, query.ownerUserId));
  if (query.contactId) conditions.push(eq(crmDeals.contactId, query.contactId));
  if (query.companyId) conditions.push(eq(crmDeals.companyId, query.companyId));
  if (query.tagId) {
    conditions.push(
      sql`exists (select 1 from ${crmDealTags} where ${crmDealTags.dealId} = ${crmDeals.id} and ${crmDealTags.tagId} = ${query.tagId})`,
    );
  }
  if (query.customFields && Object.keys(query.customFields).length > 0) {
    const set = fields ?? (await CustomFieldSet.load(tx, ctx.organizationId, 'deal'));
    const document = set.filterDocument(query.customFields);
    if (document)
      conditions.push(sql`${crmDeals.customFields} @> ${JSON.stringify(document)}::jsonb`);
  }
  return conditions;
}

export async function listDeals(
  tx: TenantTx,
  ctx: CrmContext,
  query: DealListQuery,
): Promise<Page<DealSummary>> {
  const fields = await CustomFieldSet.load(tx, ctx.organizationId, 'deal');
  const conditions = await dealFilterConditions(tx, ctx, query, fields);
  const spec = sortSpec(query.sort);
  const after = afterCursor(spec, crmDeals.id, query.cursor);
  if (after) conditions.push(after);
  const rows = await selectDeals(tx, { id: crmDeals.id, sortValue: sortValue(spec) })
    .where(and(...conditions))
    .orderBy(...orderFor(spec, crmDeals.id))
    .limit(query.limit + 1);
  const tags = await tagsForRecords(
    tx,
    'deal',
    rows.slice(0, query.limit).map((row) => row.id),
  );
  return keysetPage(spec, rows, query.limit, (row) => toSummary(ctx, row, fields, tags));
}

export async function getDeal(tx: TenantTx, ctx: CrmContext, id: string): Promise<DealSummary> {
  const [row] = await selectDeals(tx, {}).where(
    and(
      eq(crmDeals.id, id),
      eq(crmDeals.organizationId, ctx.organizationId),
      isNull(crmDeals.deletedAt),
    ),
  );
  if (!row) throw new NotFoundError('Deal');
  const fields = await CustomFieldSet.load(tx, ctx.organizationId, 'deal');
  return toSummary(ctx, row, fields, await tagsForRecords(tx, 'deal', [id]));
}

async function lockDeal(tx: TenantTx, organizationId: string, id: string): Promise<CrmDeal> {
  const [deal] = await tx
    .select()
    .from(crmDeals)
    .where(
      and(
        eq(crmDeals.id, id),
        eq(crmDeals.organizationId, organizationId),
        isNull(crmDeals.deletedAt),
      ),
    )
    .for('update');
  if (!deal) throw new NotFoundError('Deal');
  return deal;
}

async function topPosition(tx: TenantTx, stageId: string, excludeId?: string): Promise<number> {
  const conditions = [eq(crmDeals.stageId, stageId), isNull(crmDeals.deletedAt)];
  if (excludeId) conditions.push(ne(crmDeals.id, excludeId));
  const [row] = await tx
    .select({ min: sql<number | null>`min(${crmDeals.position})` })
    .from(crmDeals)
    .where(and(...conditions));
  return row?.min === null || row?.min === undefined ? 0 : row.min - POSITION_GAP;
}

/** Evenly re-spaces a stage's deals when fractional positions run out of room. */
async function renormalizeStage(tx: TenantTx, stageId: string): Promise<void> {
  await tx.execute(sql`
    update ${crmDeals} d set position = s.rn * ${POSITION_GAP}
    from (
      select id, row_number() over (order by position, id) as rn
      from ${crmDeals} where stage_id = ${stageId} and deleted_at is null
    ) s
    where d.id = s.id`);
}

async function neighbourPosition(
  tx: TenantTx,
  organizationId: string,
  stageId: string,
  dealId: string,
  movingId: string,
  path: string,
): Promise<number> {
  const [row] = await tx
    .select({ position: crmDeals.position })
    .from(crmDeals)
    .where(
      and(
        eq(crmDeals.id, dealId),
        eq(crmDeals.organizationId, organizationId),
        eq(crmDeals.stageId, stageId),
        isNull(crmDeals.deletedAt),
        ne(crmDeals.id, movingId),
      ),
    );
  if (!row)
    throw new ValidationError('Invalid position', [
      { path, message: 'Deal is not in the target stage' },
    ]);
  return row.position;
}

async function adjacentPosition(
  tx: TenantTx,
  stageId: string,
  position: number,
  direction: 'above' | 'below',
  movingId: string,
): Promise<number | null> {
  const [row] = await tx
    .select({ position: crmDeals.position })
    .from(crmDeals)
    .where(
      and(
        eq(crmDeals.stageId, stageId),
        isNull(crmDeals.deletedAt),
        ne(crmDeals.id, movingId),
        direction === 'below' ? gt(crmDeals.position, position) : lt(crmDeals.position, position),
      ),
    )
    .orderBy(direction === 'below' ? asc(crmDeals.position) : sql`${crmDeals.position} desc`)
    .limit(1);
  return row?.position ?? null;
}

async function computePosition(
  tx: TenantTx,
  organizationId: string,
  stageId: string,
  movingId: string,
  afterDealId: string | null | undefined,
  beforeDealId: string | null | undefined,
  allowRenormalize = true,
): Promise<number> {
  let above: number | null = null;
  let below: number | null = null;
  if (afterDealId) {
    above = await neighbourPosition(
      tx,
      organizationId,
      stageId,
      afterDealId,
      movingId,
      'afterDealId',
    );
    below = beforeDealId
      ? await neighbourPosition(tx, organizationId, stageId, beforeDealId, movingId, 'beforeDealId')
      : await adjacentPosition(tx, stageId, above, 'below', movingId);
  } else if (beforeDealId) {
    below = await neighbourPosition(
      tx,
      organizationId,
      stageId,
      beforeDealId,
      movingId,
      'beforeDealId',
    );
    above = await adjacentPosition(tx, stageId, below, 'above', movingId);
  } else {
    return topPosition(tx, stageId, movingId);
  }
  if (above !== null && below !== null) {
    if (below <= above) {
      throw new ValidationError('Invalid position', [
        { path: 'beforeDealId', message: 'Neighbours are out of order' },
      ]);
    }
    if (below - above < MIN_POSITION_GAP) {
      if (!allowRenormalize) throw new Error('positions did not converge after renormalizing');
      await renormalizeStage(tx, stageId);
      return computePosition(
        tx,
        organizationId,
        stageId,
        movingId,
        afterDealId,
        beforeDealId,
        false,
      );
    }
    return (above + below) / 2;
  }
  if (above !== null) return above + POSITION_GAP;
  if (below !== null) return below - POSITION_GAP;
  return 0;
}

function statusFor(stage: CrmPipelineStage): CrmDeal['status'] {
  return stage.kind;
}

async function emitStageTransition(
  tx: TenantTx,
  ctx: CrmContext,
  before: CrmDeal,
  after: {
    id: string;
    pipelineId: string;
    stageId: string;
    status: CrmDeal['status'];
    valueMinor: bigint | null;
    currency: string;
    lostReason: string | null;
  },
): Promise<void> {
  const meta = eventMeta(ctx);
  const subject = { type: 'deal', id: after.id };
  if (before.stageId !== after.stageId) {
    await emitEvent(tx, {
      ...meta,
      type: 'deal.stage_changed',
      subject,
      payload: {
        dealId: after.id,
        pipelineId: after.pipelineId,
        fromStageId: before.stageId,
        toStageId: after.stageId,
      },
    });
  }
  if (before.status !== after.status && after.status === 'won') {
    await emitEvent(tx, {
      ...meta,
      type: 'deal.won',
      subject,
      payload: {
        dealId: after.id,
        valueMinor: after.valueMinor === null ? null : after.valueMinor.toString(),
        currency: after.currency,
      },
    });
  }
  if (before.status !== after.status && after.status === 'lost') {
    await emitEvent(tx, {
      ...meta,
      type: 'deal.lost',
      subject,
      payload: { dealId: after.id, lostReason: after.lostReason },
    });
  }
}

export async function createDeal(
  tx: TenantTx,
  ctx: CrmContext,
  rawInput: CreateDealInput,
): Promise<DealSummary> {
  const input = createDealInputSchema.parse(rawInput);
  const pipelineId = input.pipelineId ?? (await defaultPipeline(tx, ctx.organizationId)).id;
  const stage = await resolveStage(tx, ctx.organizationId, pipelineId, input.stageId);
  if (input.contactId) await assertContactExists(tx, ctx.organizationId, input.contactId);
  if (input.companyId) await assertCompanyExists(tx, ctx.organizationId, input.companyId);
  const ownerUserId = input.ownerUserId === undefined ? ctx.actor.userId : input.ownerUserId;
  if (ownerUserId !== null)
    await assertActiveMember(tx, ctx.organizationId, ownerUserId, 'ownerUserId');
  const fields = await CustomFieldSet.load(tx, ctx.organizationId, 'deal');
  const customFields = await fields.apply(tx, ctx, input.customFields, null);
  const currency = input.value?.currency ?? input.currency ?? ctx.defaultCurrency;
  const status = statusFor(stage);
  const [deal] = await tx
    .insert(crmDeals)
    .values({
      organizationId: ctx.organizationId,
      name: input.name,
      pipelineId,
      stageId: stage.id,
      contactId: input.contactId ?? null,
      companyId: input.companyId ?? null,
      ownerUserId,
      valueMinor: input.value?.amountMinor ?? null,
      currency,
      probability: input.probability ?? null,
      expectedCloseDate: input.expectedCloseDate ?? null,
      status,
      closedAt: status === 'open' ? null : new Date(),
      lostReason: status === 'lost' ? (input.lostReason ?? null) : null,
      position: await topPosition(tx, stage.id),
      customFields,
      createdByUserId: ctx.actor.userId,
    })
    .returning();
  if (!deal) throw new Error('deal insert returned no row');
  if (input.tagIds?.length) await addTags(tx, ctx.organizationId, 'deal', [deal.id], input.tagIds);
  await emitEvent(tx, {
    ...eventMeta(ctx),
    type: 'deal.created',
    subject: { type: 'deal', id: deal.id },
    payload: { dealId: deal.id, pipelineId, stageId: stage.id },
  });
  return getDeal(tx, ctx, deal.id);
}

/**
 * Moves a deal to a stage (optionally in another pipeline) and position. Entering a won or lost
 * stage closes the deal; returning to an open stage reopens it.
 */
export async function moveDeal(
  tx: TenantTx,
  ctx: CrmContext,
  id: string,
  rawInput: MoveDealInput,
): Promise<{ before: DealSummary; after: DealSummary }> {
  const input = moveDealInputSchema.parse(rawInput);
  const current = await lockDeal(tx, ctx.organizationId, id);
  const before = await getDeal(tx, ctx, id);
  const pipelineId = input.pipelineId ?? current.pipelineId;
  const stage = await resolveStage(tx, ctx.organizationId, pipelineId, input.stageId);
  const position = await computePosition(
    tx,
    ctx.organizationId,
    stage.id,
    id,
    input.afterDealId,
    input.beforeDealId,
  );
  const status = statusFor(stage);
  const reopened = status === 'open';
  const lostReason =
    status === 'lost'
      ? input.lostReason === undefined
        ? current.lostReason
        : input.lostReason
      : null;
  await tx
    .update(crmDeals)
    .set({
      pipelineId,
      stageId: stage.id,
      position,
      status,
      ...(current.stageId === stage.id ? {} : { stageEnteredAt: new Date() }),
      closedAt: reopened ? null : current.status === status ? current.closedAt : new Date(),
      lostReason,
    })
    .where(and(eq(crmDeals.id, id), eq(crmDeals.organizationId, ctx.organizationId)));
  await emitStageTransition(tx, ctx, current, {
    id,
    pipelineId,
    stageId: stage.id,
    status,
    valueMinor: current.valueMinor,
    currency: current.currency,
    lostReason,
  });
  return { before, after: await getDeal(tx, ctx, id) };
}

export async function updateDeal(
  tx: TenantTx,
  ctx: CrmContext,
  id: string,
  rawInput: UpdateDealInput,
): Promise<{ before: DealSummary; after: DealSummary; changedFields: string[] }> {
  const input = updateDealInputSchema.parse(rawInput);
  const current = await lockDeal(tx, ctx.organizationId, id);
  const before = await getDeal(tx, ctx, id);
  const set: Partial<typeof crmDeals.$inferInsert> = {};
  const changed: string[] = [];
  const assign = <K extends keyof CrmDeal & keyof typeof crmDeals.$inferInsert>(
    key: K,
    value: CrmDeal[K] | undefined,
  ) => {
    if (value === undefined) return;
    const same =
      typeof value === 'object' && value !== null
        ? JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)) ===
          JSON.stringify(current[key], (_k, v: unknown) =>
            typeof v === 'bigint' ? v.toString() : v,
          )
        : value === current[key];
    if (!same) {
      (set as Record<string, unknown>)[key] = value;
      changed.push(key);
    }
  };
  assign('name', input.name);
  if (input.contactId !== undefined && input.contactId !== current.contactId) {
    if (input.contactId !== null)
      await assertContactExists(tx, ctx.organizationId, input.contactId);
    assign('contactId', input.contactId);
  }
  if (input.companyId !== undefined && input.companyId !== current.companyId) {
    if (input.companyId !== null)
      await assertCompanyExists(tx, ctx.organizationId, input.companyId);
    assign('companyId', input.companyId);
  }
  if (input.ownerUserId !== undefined && input.ownerUserId !== current.ownerUserId) {
    if (input.ownerUserId !== null)
      await assertActiveMember(tx, ctx.organizationId, input.ownerUserId, 'ownerUserId');
    assign('ownerUserId', input.ownerUserId);
  }
  if (input.value !== undefined) {
    if (input.value === null) {
      if (current.valueMinor !== null) {
        set.valueMinor = null;
        changed.push('value');
      }
    } else if (
      input.value.amountMinor !== current.valueMinor ||
      input.value.currency !== current.currency
    ) {
      set.valueMinor = input.value.amountMinor;
      set.currency = input.value.currency;
      changed.push('value');
    }
  } else if (input.currency !== undefined && input.currency !== current.currency) {
    if (current.valueMinor !== null) {
      throw new ValidationError('Change the currency together with the value', [
        { path: 'currency', message: 'Send value with the new currency instead' },
      ]);
    }
    assign('currency', input.currency);
  }
  assign('probability', input.probability);
  assign('expectedCloseDate', input.expectedCloseDate);
  if (input.lostReason !== undefined && current.status === 'lost')
    assign('lostReason', input.lostReason);
  if (input.customFields !== undefined) {
    const fields = await CustomFieldSet.load(tx, ctx.organizationId, 'deal');
    assign('customFields', await fields.apply(tx, ctx, input.customFields, current.customFields));
  }
  if (input.tagIds) {
    const tagChanges = await setRecordTags(tx, ctx.organizationId, 'deal', id, input.tagIds);
    if (tagChanges.added.length > 0 || tagChanges.removed.length > 0) changed.push('tags');
  }
  if (changed.length > 0) {
    await tx
      .update(crmDeals)
      .set({ ...set, updatedAt: new Date() })
      .where(and(eq(crmDeals.id, id), eq(crmDeals.organizationId, ctx.organizationId)));
    await emitEvent(tx, {
      ...eventMeta(ctx),
      type: 'deal.updated',
      subject: { type: 'deal', id },
      payload: { dealId: id, changedFields: changed },
    });
  }
  const pipelineChanged = input.pipelineId !== undefined && input.pipelineId !== current.pipelineId;
  const stageChanged = input.stageId !== undefined && input.stageId !== current.stageId;
  if (pipelineChanged || stageChanged) {
    if (input.stageId === undefined) {
      throw new ValidationError('Choose a stage in the new pipeline', [
        { path: 'stageId', message: 'Required' },
      ]);
    }
    await moveDeal(tx, ctx, id, {
      stageId: input.stageId,
      pipelineId: input.pipelineId,
      lostReason: input.lostReason,
    });
    changed.push('stageId');
  }
  const after = changed.length > 0 ? await getDeal(tx, ctx, id) : before;
  return { before, after, changedFields: changed };
}

export async function deleteDeal(tx: TenantTx, ctx: CrmContext, id: string): Promise<DealSummary> {
  await lockDeal(tx, ctx.organizationId, id);
  const before = await getDeal(tx, ctx, id);
  await tx
    .update(crmDeals)
    .set({ deletedAt: new Date() })
    .where(and(eq(crmDeals.id, id), eq(crmDeals.organizationId, ctx.organizationId)));
  await emitEvent(tx, {
    ...eventMeta(ctx),
    type: 'deal.deleted',
    subject: { type: 'deal', id },
    payload: { dealId: id },
  });
  return before;
}

export interface BoardStage extends StageSummary {
  deals: DealSummary[];
  /** Number of deals in the stage (beyond the page shown). */
  count: number;
  /** Total value per currency (decimal strings). */
  totals: MoneyJson[];
}

export interface DealBoard {
  pipeline: { id: string; name: string; isDefault: boolean };
  stages: BoardStage[];
}

export const boardQuerySchema = z.object({
  ownerUserId: z.union([z.uuid(), z.literal('me'), z.literal('none')]).optional(),
  q: z.string().trim().max(200).optional(),
  perStage: z.coerce.number().int().min(1).max(200).default(50),
});

/** Kanban view of a pipeline: ordered deals per stage plus counts and per-currency totals. */
export async function dealBoard(
  tx: TenantTx,
  ctx: CrmContext,
  pipelineId: string,
  query: z.infer<typeof boardQuerySchema>,
): Promise<DealBoard> {
  const pipeline = await getPipeline(tx, ctx.organizationId, pipelineId);
  const fields = await CustomFieldSet.load(tx, ctx.organizationId, 'deal');
  const conditions = await dealFilterConditions(
    tx,
    ctx,
    { pipelineId, ownerUserId: query.ownerUserId, q: query.q },
    fields,
  );
  const totalsRows = await tx
    .select({
      stageId: crmDeals.stageId,
      currency: crmDeals.currency,
      n: count(),
      total: sql<string | null>`sum(${crmDeals.valueMinor})::text`,
    })
    .from(crmDeals)
    .where(and(...conditions))
    .groupBy(crmDeals.stageId, crmDeals.currency);
  const stages: BoardStage[] = [];
  for (const stage of pipeline.stages) {
    const rows = await selectDeals(tx, {})
      .where(and(...conditions, eq(crmDeals.stageId, stage.id)))
      .orderBy(asc(crmDeals.position), asc(crmDeals.id))
      .limit(query.perStage);
    const tags = await tagsForRecords(
      tx,
      'deal',
      rows.map((row) => row.deal.id),
    );
    const stageTotals = totalsRows.filter((row) => row.stageId === stage.id);
    stages.push({
      ...stage,
      deals: rows.map((row) => toSummary(ctx, row, fields, tags)),
      count: stageTotals.reduce((sum, row) => sum + row.n, 0),
      totals: stageTotals
        .filter((row) => row.total !== null && isCurrencyCode(row.currency))
        .map((row) =>
          toMoneyJson(money(BigInt(row.total ?? '0'), row.currency as Parameters<typeof money>[1])),
        )
        .sort((a, b) => a.currency.localeCompare(b.currency)),
    });
  }
  return {
    pipeline: { id: pipeline.id, name: pipeline.name, isDefault: pipeline.isDefault },
    stages,
  };
}

export const dealBulkInputSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('delete'), ids: z.array(z.uuid()).min(1).max(MAX_BULK_IDS) }),
  z.object({
    action: z.literal('assign_owner'),
    ids: z.array(z.uuid()).min(1).max(MAX_BULK_IDS),
    ownerUserId: z.uuid().nullable(),
  }),
  z.object({
    action: z.literal('add_tags'),
    ids: z.array(z.uuid()).min(1).max(MAX_BULK_IDS),
    tagIds: tagIdsSchema.pipe(z.array(z.uuid()).min(1)),
  }),
  z.object({
    action: z.literal('remove_tags'),
    ids: z.array(z.uuid()).min(1).max(MAX_BULK_IDS),
    tagIds: tagIdsSchema.pipe(z.array(z.uuid()).min(1)),
  }),
]);
export type DealBulkInput = z.infer<typeof dealBulkInputSchema>;

export async function bulkUpdateDeals(
  tx: TenantTx,
  ctx: CrmContext,
  input: DealBulkInput,
): Promise<{ affected: number; ids: string[] }> {
  const targets = await tx
    .select({ id: crmDeals.id })
    .from(crmDeals)
    .where(
      and(
        eq(crmDeals.organizationId, ctx.organizationId),
        isNull(crmDeals.deletedAt),
        inArray(crmDeals.id, [...new Set(input.ids)]),
      ),
    )
    .orderBy(asc(crmDeals.id))
    .for('update');
  const ids = targets.map((row) => row.id);
  if (ids.length === 0) return { affected: 0, ids };
  const meta = eventMeta(ctx);
  const scope = and(eq(crmDeals.organizationId, ctx.organizationId), inArray(crmDeals.id, ids));
  switch (input.action) {
    case 'delete':
      await tx.update(crmDeals).set({ deletedAt: new Date() }).where(scope);
      for (const id of ids) {
        await emitEvent(tx, {
          ...meta,
          type: 'deal.deleted',
          subject: { type: 'deal', id },
          payload: { dealId: id },
        });
      }
      break;
    case 'assign_owner':
      if (input.ownerUserId !== null) {
        await assertActiveMember(tx, ctx.organizationId, input.ownerUserId, 'ownerUserId');
      }
      await tx.update(crmDeals).set({ ownerUserId: input.ownerUserId }).where(scope);
      for (const id of ids) {
        await emitEvent(tx, {
          ...meta,
          type: 'deal.updated',
          subject: { type: 'deal', id },
          payload: { dealId: id, changedFields: ['ownerUserId'] },
        });
      }
      break;
    case 'add_tags':
      await addTags(tx, ctx.organizationId, 'deal', ids, input.tagIds);
      break;
    case 'remove_tags':
      await removeTags(tx, ctx.organizationId, 'deal', ids, input.tagIds);
      break;
  }
  return { affected: ids.length, ids };
}
