import { displayName } from '@businessos/crm';
import {
  appointments,
  appointmentTypes,
  automationRuns,
  automationWorkflows,
  commerceInvoicePayments,
  commerceInvoices,
  commerceRefunds,
  conversations,
  crmCompanies,
  crmContacts,
  crmDeals,
  crmPipelines,
  crmPipelineStages,
  crmTasks,
  formSubmissions,
  forms,
  messages,
  users,
  type TenantTx,
} from '@businessos/database';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { bucketOf, dateBucketOf, localDate, within, withinDates, type ReportRange } from './range';
import {
  big,
  can,
  count,
  decimal,
  moneySeries,
  moneyValues,
  percent,
  series,
  type ReportContext,
  type ReportResult,
  type ReportTable,
  type ReportValue,
} from './result';

export interface RunOptions {
  /** Include breakdown tables (the dashboard skips them). */
  detail: boolean;
  now: Date;
}

export type ReportRunner = (
  tx: TenantTx,
  ctx: ReportContext,
  range: ReportRange,
  options: RunOptions,
) => Promise<Omit<ReportResult, 'key' | 'range'>>;

type Row = Record<string, unknown>;

async function rows<T extends Row>(tx: TenantTx, query: ReturnType<typeof sql>): Promise<T[]> {
  return (await tx.execute<T>(query)).rows as T[];
}

const TOP_LIMIT = 10;
const TABLE_LIMIT = 200;

// ── Sales pipeline (crm.deal.read) ──────────────────────────────────────────────────────

export const salesPipeline: ReportRunner = async (tx, ctx, range, options) => {
  const org = ctx.organizationId;
  const open = await rows<{ currency: string; deals: string; value: string; weighted: string }>(
    tx,
    sql`
      select ${crmDeals.currency} as currency, count(*)::text as deals,
             coalesce(sum(${crmDeals.valueMinor}), 0)::text as value,
             coalesce(sum((coalesce(${crmDeals.valueMinor}, 0)
               * coalesce(${crmDeals.probability}, ${crmPipelineStages.probability}) + 50) / 100), 0)::text as weighted
      from ${crmDeals}
      join ${crmPipelineStages} on ${crmPipelineStages.id} = ${crmDeals.stageId}
        and ${crmPipelineStages.organizationId} = ${crmDeals.organizationId}
      where ${crmDeals.organizationId} = ${org} and ${crmDeals.deletedAt} is null
        and ${crmDeals.status} = 'open'
      group by 1`,
  );
  const closed = await rows<{ status: string; currency: string; deals: string; value: string }>(
    tx,
    sql`
      select ${crmDeals.status} as status, ${crmDeals.currency} as currency, count(*)::text as deals,
             coalesce(sum(${crmDeals.valueMinor}), 0)::text as value
      from ${crmDeals}
      where ${crmDeals.organizationId} = ${org} and ${crmDeals.deletedAt} is null
        and ${crmDeals.status} in ('won', 'lost') and ${within(range, crmDeals.closedAt)}
      group by 1, 2`,
  );
  const won = closed.filter((row) => row.status === 'won');
  const wonCount = won.reduce((sum, row) => sum + big(row.deals), 0n);
  const lostCount = closed
    .filter((row) => row.status === 'lost')
    .reduce((sum, row) => sum + big(row.deals), 0n);
  const winRate = percent(wonCount, wonCount + lostCount);
  const wonSeries = await rows<{ bucket: string; value: string }>(
    tx,
    sql`
      select ${bucketOf(range, crmDeals.closedAt)} as bucket, count(*)::text as value
      from ${crmDeals}
      where ${crmDeals.organizationId} = ${org} and ${crmDeals.deletedAt} is null
        and ${crmDeals.status} = 'won' and ${within(range, crmDeals.closedAt)}
      group by 1`,
  );
  const createdSeries = await rows<{ bucket: string; value: string }>(
    tx,
    sql`
      select ${bucketOf(range, crmDeals.createdAt)} as bucket, count(*)::text as value
      from ${crmDeals}
      where ${crmDeals.organizationId} = ${org} and ${crmDeals.deletedAt} is null
        and ${within(range, crmDeals.createdAt)}
      group by 1`,
  );
  const metrics: ReportValue[] = [
    count(
      'open_deals',
      open.reduce((sum, row) => sum + big(row.deals), 0n),
    ),
    ...moneyValues(
      'open_value',
      open.map((row) => ({ currency: row.currency, minor: big(row.value) })),
      ctx.defaultCurrency,
    ),
    ...moneyValues(
      'weighted_value',
      open.map((row) => ({ currency: row.currency, minor: big(row.weighted) })),
      ctx.defaultCurrency,
    ),
    count('won_deals', wonCount),
    count('lost_deals', lostCount),
    ...moneyValues(
      'won_value',
      won.map((row) => ({ currency: row.currency, minor: big(row.value) })),
      ctx.defaultCurrency,
    ),
    { key: 'win_rate', value: winRate ?? '—', currency: null },
  ];
  const tables: ReportTable[] = [];
  if (options.detail) {
    const stages = await rows<{
      pipeline: string;
      stage: string;
      currency: string;
      deals: string;
      value: string;
    }>(
      tx,
      sql`
        select ${crmPipelines.name} as pipeline, ${crmPipelineStages.name} as stage,
               ${crmDeals.currency} as currency, count(*)::text as deals,
               coalesce(sum(${crmDeals.valueMinor}), 0)::text as value
        from ${crmDeals}
        join ${crmPipelineStages} on ${crmPipelineStages.id} = ${crmDeals.stageId}
          and ${crmPipelineStages.organizationId} = ${crmDeals.organizationId}
        join ${crmPipelines} on ${crmPipelines.id} = ${crmDeals.pipelineId}
          and ${crmPipelines.organizationId} = ${crmDeals.organizationId}
        where ${crmDeals.organizationId} = ${org} and ${crmDeals.deletedAt} is null
          and ${crmDeals.status} = 'open'
        group by ${crmPipelines.name}, ${crmPipelines.id}, ${crmPipelineStages.name},
                 ${crmPipelineStages.position}, ${crmDeals.currency}
        order by ${crmPipelines.name}, ${crmPipelines.id}, ${crmPipelineStages.position}, ${crmDeals.currency}
        limit ${TABLE_LIMIT}`,
    );
    tables.push({
      key: 'open_by_stage',
      columns: ['pipeline', 'stage', 'deals', 'currency', 'value'],
      rows: stages.map((row) => [
        row.pipeline,
        row.stage,
        row.deals,
        row.currency,
        decimal(big(row.value), row.currency),
      ]),
    });
  }
  return {
    metrics,
    series: [
      series(
        range,
        'deals_won',
        wonSeries.map((row) => ({ bucket: row.bucket, value: big(row.value) })),
      ),
      series(
        range,
        'deals_created',
        createdSeries.map((row) => ({ bucket: row.bucket, value: big(row.value) })),
      ),
    ],
    tables,
  };
};

// ── Revenue (commerce.invoice.read) ─────────────────────────────────────────────────────

export const revenue: ReportRunner = async (tx, ctx, range, options) => {
  const org = ctx.organizationId;
  const today = localDate(options.now, ctx.timezone);
  const invoiced = await rows<{ currency: string; invoices: string; total: string }>(
    tx,
    sql`
      select ${commerceInvoices.currency} as currency, count(*)::text as invoices,
             coalesce(sum(${commerceInvoices.totalMinor}), 0)::text as total
      from ${commerceInvoices}
      where ${commerceInvoices.organizationId} = ${org}
        and ${commerceInvoices.status} in ('open', 'paid')
        and ${withinDates(range, commerceInvoices.issueDate)}
      group by 1`,
  );
  const collected = await rows<{ currency: string; total: string }>(
    tx,
    sql`
      select ${commerceInvoicePayments.currency} as currency,
             coalesce(sum(${commerceInvoicePayments.amountMinor}), 0)::text as total
      from ${commerceInvoicePayments}
      where ${commerceInvoicePayments.organizationId} = ${org}
        and ${within(range, commerceInvoicePayments.receivedAt)}
      group by 1`,
  );
  const refunded = await rows<{ currency: string; total: string }>(
    tx,
    sql`
      select ${commerceRefunds.currency} as currency,
             coalesce(sum(${commerceRefunds.amountMinor}), 0)::text as total
      from ${commerceRefunds}
      where ${commerceRefunds.organizationId} = ${org}
        and ${commerceRefunds.status} in ('pending', 'succeeded')
        and ${within(range, commerceRefunds.createdAt)}
      group by 1`,
  );
  const open = await rows<{ currency: string; due: string; overdue: string; overdueCount: string }>(
    tx,
    sql`
      select ${commerceInvoices.currency} as currency,
             coalesce(sum(greatest(${commerceInvoices.totalMinor} - ${commerceInvoices.amountPaidMinor}, 0)), 0)::text as due,
             coalesce(sum(greatest(${commerceInvoices.totalMinor} - ${commerceInvoices.amountPaidMinor}, 0))
               filter (where ${commerceInvoices.dueDate} < ${today}::date), 0)::text as overdue,
             count(*) filter (where ${commerceInvoices.dueDate} < ${today}::date)::text as "overdueCount"
      from ${commerceInvoices}
      where ${commerceInvoices.organizationId} = ${org} and ${commerceInvoices.status} = 'open'
      group by 1`,
  );
  const currencies = [...new Set([...collected, ...refunded].map((row) => row.currency))].sort();
  const net = currencies.map((currency) => ({
    currency,
    minor:
      big(collected.find((row) => row.currency === currency)?.total) -
      big(refunded.find((row) => row.currency === currency)?.total),
  }));
  const invoicedSeries = await rows<{ bucket: string; currency: string; total: string }>(
    tx,
    sql`
      select ${dateBucketOf(range, commerceInvoices.issueDate)} as bucket,
             ${commerceInvoices.currency} as currency,
             coalesce(sum(${commerceInvoices.totalMinor}), 0)::text as total
      from ${commerceInvoices}
      where ${commerceInvoices.organizationId} = ${org}
        and ${commerceInvoices.status} in ('open', 'paid')
        and ${withinDates(range, commerceInvoices.issueDate)}
      group by 1, 2`,
  );
  const collectedSeries = await rows<{ bucket: string; currency: string; total: string }>(
    tx,
    sql`
      select ${bucketOf(range, commerceInvoicePayments.receivedAt)} as bucket,
             ${commerceInvoicePayments.currency} as currency,
             coalesce(sum(${commerceInvoicePayments.amountMinor}), 0)::text as total
      from ${commerceInvoicePayments}
      where ${commerceInvoicePayments.organizationId} = ${org}
        and ${within(range, commerceInvoicePayments.receivedAt)}
      group by 1, 2`,
  );
  const tables: ReportTable[] = [];
  if (options.detail) {
    const top = await rows<{
      contactId: string;
      companyId: string | null;
      currency: string;
      invoiced: string;
      paid: string;
    }>(
      tx,
      sql`
        select ${commerceInvoices.contactId} as "contactId", ${commerceInvoices.companyId} as "companyId",
               ${commerceInvoices.currency} as currency,
               sum(${commerceInvoices.totalMinor})::text as invoiced,
               sum(least(${commerceInvoices.amountPaidMinor}, ${commerceInvoices.totalMinor}))::text as paid
        from ${commerceInvoices}
        where ${commerceInvoices.organizationId} = ${org}
          and ${commerceInvoices.status} in ('open', 'paid')
          and ${withinDates(range, commerceInvoices.issueDate)}
        group by 1, 2, 3
        order by sum(${commerceInvoices.totalMinor}) desc, 1
        limit ${TOP_LIMIT}`,
    );
    // Names only for readers who may see contacts / companies.
    const contactIds = [...new Set(top.map((row) => row.contactId))];
    const companyIds = [
      ...new Set(top.map((row) => row.companyId).filter((id): id is string => id !== null)),
    ];
    const contactRows =
      can(ctx, 'crm.contact.read') && contactIds.length > 0
        ? await tx
            .select()
            .from(crmContacts)
            .where(and(eq(crmContacts.organizationId, org), inArray(crmContacts.id, contactIds)))
        : [];
    const companyRows =
      can(ctx, 'crm.company.read') && companyIds.length > 0
        ? await tx
            .select({ id: crmCompanies.id, name: crmCompanies.name })
            .from(crmCompanies)
            .where(and(eq(crmCompanies.organizationId, org), inArray(crmCompanies.id, companyIds)))
        : [];
    tables.push({
      key: 'top_customers',
      columns: ['customer', 'company', 'currency', 'invoiced', 'paid'],
      rows: top.map((row) => {
        const contact = contactRows.find((entry) => entry.id === row.contactId);
        return [
          contact ? displayName(contact) : null,
          companyRows.find((entry) => entry.id === row.companyId)?.name ?? null,
          row.currency,
          decimal(big(row.invoiced), row.currency),
          decimal(big(row.paid), row.currency),
        ];
      }),
    });
  }
  return {
    metrics: [
      count(
        'invoices_issued',
        invoiced.reduce((sum, row) => sum + big(row.invoices), 0n),
      ),
      ...moneyValues(
        'invoiced',
        invoiced.map((row) => ({ currency: row.currency, minor: big(row.total) })),
        ctx.defaultCurrency,
      ),
      ...moneyValues(
        'collected',
        collected.map((row) => ({ currency: row.currency, minor: big(row.total) })),
        ctx.defaultCurrency,
      ),
      ...moneyValues(
        'refunded',
        refunded.map((row) => ({ currency: row.currency, minor: big(row.total) })),
        ctx.defaultCurrency,
      ),
      ...moneyValues('net_collected', net, ctx.defaultCurrency),
      ...moneyValues(
        'outstanding',
        open.map((row) => ({ currency: row.currency, minor: big(row.due) })),
        ctx.defaultCurrency,
      ),
      ...moneyValues(
        'overdue',
        open.map((row) => ({ currency: row.currency, minor: big(row.overdue) })),
        ctx.defaultCurrency,
      ),
      count(
        'overdue_invoices',
        open.reduce((sum, row) => sum + big(row.overdueCount), 0n),
      ),
    ],
    series: [
      ...moneySeries(
        range,
        'invoiced',
        invoicedSeries.map((row) => ({
          bucket: row.bucket,
          currency: row.currency,
          minor: big(row.total),
        })),
        ctx.defaultCurrency,
      ),
      ...moneySeries(
        range,
        'collected',
        collectedSeries.map((row) => ({
          bucket: row.bucket,
          currency: row.currency,
          minor: big(row.total),
        })),
        ctx.defaultCurrency,
      ),
    ],
    tables,
  };
};

// ── Contacts (crm.contact.read) ─────────────────────────────────────────────────────────

export const contacts: ReportRunner = async (tx, ctx, range, options) => {
  const org = ctx.organizationId;
  const [totals] = await rows<{ total: string; created: string }>(
    tx,
    sql`
      select count(*)::text as total,
             count(*) filter (where ${within(range, crmContacts.createdAt)})::text as created
      from ${crmContacts}
      where ${crmContacts.organizationId} = ${org} and ${crmContacts.deletedAt} is null`,
  );
  const created = await rows<{ bucket: string; value: string }>(
    tx,
    sql`
      select ${bucketOf(range, crmContacts.createdAt)} as bucket, count(*)::text as value
      from ${crmContacts}
      where ${crmContacts.organizationId} = ${org} and ${crmContacts.deletedAt} is null
        and ${within(range, crmContacts.createdAt)}
      group by 1`,
  );
  const tables: ReportTable[] = [];
  if (options.detail) {
    const bySource = await rows<{ source: string; contacts: string }>(
      tx,
      sql`
        select ${crmContacts.source} as source, count(*)::text as contacts
        from ${crmContacts}
        where ${crmContacts.organizationId} = ${org} and ${crmContacts.deletedAt} is null
          and ${within(range, crmContacts.createdAt)}
        group by 1 order by count(*) desc, 1 limit ${TABLE_LIMIT}`,
    );
    const byStage = await rows<{ stage: string; contacts: string }>(
      tx,
      sql`
        select ${crmContacts.lifecycleStage} as stage, count(*)::text as contacts
        from ${crmContacts}
        where ${crmContacts.organizationId} = ${org} and ${crmContacts.deletedAt} is null
        group by 1 order by count(*) desc, 1`,
    );
    tables.push(
      {
        key: 'new_by_source',
        columns: ['source', 'contacts'],
        rows: bySource.map((row) => [row.source, row.contacts]),
      },
      {
        key: 'by_lifecycle_stage',
        columns: ['lifecycle_stage', 'contacts'],
        rows: byStage.map((row) => [row.stage, row.contacts]),
      },
    );
  }
  return {
    metrics: [count('contacts', big(totals?.total)), count('new_contacts', big(totals?.created))],
    series: [
      series(
        range,
        'new_contacts',
        created.map((row) => ({ bucket: row.bucket, value: big(row.value) })),
      ),
    ],
    tables,
  };
};

// ── Tasks (crm.task.read) ───────────────────────────────────────────────────────────────

export const tasks: ReportRunner = async (tx, ctx, range, options) => {
  const org = ctx.organizationId;
  const [totals] = await rows<{ open: string; overdue: string; completed: string; mine: string }>(
    tx,
    sql`
      select count(*) filter (where ${crmTasks.status} = 'open')::text as open,
             count(*) filter (where ${crmTasks.status} = 'open' and ${crmTasks.dueAt} < ${options.now})::text as overdue,
             count(*) filter (where ${crmTasks.status} = 'open' and ${crmTasks.assigneeUserId} = ${ctx.userId})::text as mine,
             count(*) filter (where ${crmTasks.status} = 'completed' and ${within(range, crmTasks.completedAt)})::text as completed
      from ${crmTasks}
      where ${crmTasks.organizationId} = ${org} and ${crmTasks.deletedAt} is null`,
  );
  const completed = await rows<{ bucket: string; value: string }>(
    tx,
    sql`
      select ${bucketOf(range, crmTasks.completedAt)} as bucket, count(*)::text as value
      from ${crmTasks}
      where ${crmTasks.organizationId} = ${org} and ${crmTasks.deletedAt} is null
        and ${crmTasks.status} = 'completed' and ${within(range, crmTasks.completedAt)}
      group by 1`,
  );
  const tables: ReportTable[] = [];
  if (options.detail) {
    const byAssignee = await rows<{ name: string | null; open: string; overdue: string }>(
      tx,
      sql`
        select ${users.name} as name, count(*)::text as open,
               count(*) filter (where ${crmTasks.dueAt} < ${options.now})::text as overdue
        from ${crmTasks}
        left join ${users} on ${users.id} = ${crmTasks.assigneeUserId}
        where ${crmTasks.organizationId} = ${org} and ${crmTasks.deletedAt} is null
          and ${crmTasks.status} = 'open'
        group by ${crmTasks.assigneeUserId}, ${users.name}
        order by count(*) desc, 1 nulls last limit ${TABLE_LIMIT}`,
    );
    tables.push({
      key: 'open_by_assignee',
      columns: ['assignee', 'open', 'overdue'],
      rows: byAssignee.map((row) => [row.name, row.open, row.overdue]),
    });
  }
  return {
    metrics: [
      count('open_tasks', big(totals?.open)),
      count('overdue_tasks', big(totals?.overdue)),
      count('my_open_tasks', big(totals?.mine)),
      count('completed_tasks', big(totals?.completed)),
    ],
    series: [
      series(
        range,
        'tasks_completed',
        completed.map((row) => ({ bucket: row.bucket, value: big(row.value) })),
      ),
    ],
    tables,
  };
};

// ── Conversations (communications.read) ─────────────────────────────────────────────────

export const conversationsReport: ReportRunner = async (tx, ctx, range, options) => {
  const org = ctx.organizationId;
  const [open] = await rows<{ open: string; unassigned: string; started: string }>(
    tx,
    sql`
      select count(*) filter (where ${conversations.status} = 'open')::text as open,
             count(*) filter (where ${conversations.status} = 'open' and ${conversations.assigneeUserId} is null)::text as unassigned,
             count(*) filter (where ${within(range, conversations.createdAt)})::text as started
      from ${conversations}
      where ${conversations.organizationId} = ${org}`,
  );
  const traffic = await rows<{ bucket: string; direction: string; value: string }>(
    tx,
    sql`
      select ${bucketOf(range, messages.createdAt)} as bucket, ${messages.direction} as direction,
             count(*)::text as value
      from ${messages}
      where ${messages.organizationId} = ${org} and ${messages.direction} in ('inbound', 'outbound')
        and ${within(range, messages.createdAt)}
      group by 1, 2`,
  );
  const sum = (direction: string) =>
    traffic
      .filter((row) => row.direction === direction)
      .reduce((total, row) => total + big(row.value), 0n);
  const tables: ReportTable[] = [];
  if (options.detail) {
    const byChannel = await rows<{
      channel: string;
      received: string;
      sent: string;
      failed: string;
    }>(
      tx,
      sql`
        select ${conversations.channel} as channel,
               count(*) filter (where ${messages.direction} = 'inbound')::text as received,
               count(*) filter (where ${messages.direction} = 'outbound' and ${messages.status} <> 'failed')::text as sent,
               count(*) filter (where ${messages.direction} = 'outbound' and ${messages.status} = 'failed')::text as failed
        from ${messages}
        join ${conversations} on ${conversations.id} = ${messages.conversationId}
          and ${conversations.organizationId} = ${messages.organizationId}
        where ${messages.organizationId} = ${org} and ${within(range, messages.createdAt)}
        group by 1 order by 1`,
    );
    tables.push({
      key: 'by_channel',
      columns: ['channel', 'received', 'sent', 'failed'],
      rows: byChannel.map((row) => [row.channel, row.received, row.sent, row.failed]),
    });
  }
  return {
    metrics: [
      count('open_conversations', big(open?.open)),
      count('unassigned_conversations', big(open?.unassigned)),
      count('conversations_started', big(open?.started)),
      count('messages_received', sum('inbound')),
      count('messages_sent', sum('outbound')),
    ],
    series: [
      series(
        range,
        'messages_received',
        traffic
          .filter((row) => row.direction === 'inbound')
          .map((row) => ({ bucket: row.bucket, value: big(row.value) })),
      ),
      series(
        range,
        'messages_sent',
        traffic
          .filter((row) => row.direction === 'outbound')
          .map((row) => ({ bucket: row.bucket, value: big(row.value) })),
      ),
    ],
    tables,
  };
};

// ── Appointments (calendar.appointment.read) ────────────────────────────────────────────

export const appointmentsReport: ReportRunner = async (tx, ctx, range, options) => {
  const org = ctx.organizationId;
  const weekAhead = new Date(options.now.getTime() + 7 * 86_400_000);
  const [totals] = await rows<{
    scheduled: string;
    completed: string;
    noShow: string;
    cancelled: string;
    booked: string;
    upcoming: string;
  }>(
    tx,
    sql`
      select count(*) filter (where ${appointments.status} = 'scheduled' and ${within(range, appointments.startsAt)})::text as scheduled,
             count(*) filter (where ${appointments.status} = 'completed' and ${within(range, appointments.startsAt)})::text as completed,
             count(*) filter (where ${appointments.status} = 'no_show' and ${within(range, appointments.startsAt)})::text as "noShow",
             count(*) filter (where ${appointments.status} = 'cancelled' and ${within(range, appointments.startsAt)})::text as cancelled,
             count(*) filter (where ${within(range, appointments.createdAt)})::text as booked,
             count(*) filter (where ${appointments.status} = 'scheduled'
               and ${appointments.startsAt} >= ${options.now} and ${appointments.startsAt} < ${weekAhead})::text as upcoming
      from ${appointments}
      where ${appointments.organizationId} = ${org}`,
  );
  const byStart = await rows<{ bucket: string; value: string }>(
    tx,
    sql`
      select ${bucketOf(range, appointments.startsAt)} as bucket, count(*)::text as value
      from ${appointments}
      where ${appointments.organizationId} = ${org} and ${appointments.status} <> 'cancelled'
        and ${within(range, appointments.startsAt)}
      group by 1`,
  );
  const tables: ReportTable[] = [];
  if (options.detail) {
    const byType = await rows<{
      type: string | null;
      scheduled: string;
      completed: string;
      noShow: string;
      cancelled: string;
    }>(
      tx,
      sql`
        select ${appointmentTypes.name} as type,
               count(*) filter (where ${appointments.status} = 'scheduled')::text as scheduled,
               count(*) filter (where ${appointments.status} = 'completed')::text as completed,
               count(*) filter (where ${appointments.status} = 'no_show')::text as "noShow",
               count(*) filter (where ${appointments.status} = 'cancelled')::text as cancelled
        from ${appointments}
        left join ${appointmentTypes} on ${appointmentTypes.id} = ${appointments.appointmentTypeId}
          and ${appointmentTypes.organizationId} = ${appointments.organizationId}
        where ${appointments.organizationId} = ${org} and ${within(range, appointments.startsAt)}
        group by ${appointments.appointmentTypeId}, ${appointmentTypes.name}
        order by count(*) desc, 1 nulls last limit ${TABLE_LIMIT}`,
    );
    tables.push({
      key: 'by_type',
      columns: ['appointment_type', 'scheduled', 'completed', 'no_show', 'cancelled'],
      rows: byType.map((row) => [
        row.type,
        row.scheduled,
        row.completed,
        row.noShow,
        row.cancelled,
      ]),
    });
  }
  const held = big(totals?.completed);
  const noShows = big(totals?.noShow);
  return {
    metrics: [
      count('appointments_booked', big(totals?.booked)),
      count('appointments_scheduled', big(totals?.scheduled)),
      count('appointments_completed', held),
      count('appointments_no_show', noShows),
      count('appointments_cancelled', big(totals?.cancelled)),
      { key: 'no_show_rate', value: percent(noShows, held + noShows) ?? '—', currency: null },
      count('upcoming_7_days', big(totals?.upcoming)),
    ],
    series: [
      series(
        range,
        'appointments',
        byStart.map((row) => ({ bucket: row.bucket, value: big(row.value) })),
      ),
    ],
    tables,
  };
};

// ── Forms (forms.submission.read) ───────────────────────────────────────────────────────

export const formsReport: ReportRunner = async (tx, ctx, range, options) => {
  const org = ctx.organizationId;
  const byBucket = await rows<{ bucket: string; status: string; value: string }>(
    tx,
    sql`
      select ${bucketOf(range, formSubmissions.submittedAt)} as bucket, ${formSubmissions.status} as status,
             count(*)::text as value
      from ${formSubmissions}
      where ${formSubmissions.organizationId} = ${org} and ${within(range, formSubmissions.submittedAt)}
      group by 1, 2`,
  );
  const total = (status: string) =>
    byBucket.filter((row) => row.status === status).reduce((sum, row) => sum + big(row.value), 0n);
  const tables: ReportTable[] = [];
  if (options.detail) {
    const byForm = await rows<{ form: string; accepted: string; spam: string }>(
      tx,
      sql`
        select ${forms.name} as form,
               count(*) filter (where ${formSubmissions.status} = 'accepted')::text as accepted,
               count(*) filter (where ${formSubmissions.status} = 'spam')::text as spam
        from ${formSubmissions}
        join ${forms} on ${forms.id} = ${formSubmissions.formId}
          and ${forms.organizationId} = ${formSubmissions.organizationId}
        where ${formSubmissions.organizationId} = ${org} and ${within(range, formSubmissions.submittedAt)}
        group by ${forms.id}, ${forms.name}
        order by count(*) desc, 1 limit ${TABLE_LIMIT}`,
    );
    tables.push({
      key: 'by_form',
      columns: ['form', 'accepted', 'spam'],
      rows: byForm.map((row) => [row.form, row.accepted, row.spam]),
    });
  }
  return {
    metrics: [count('submissions', total('accepted')), count('spam_submissions', total('spam'))],
    series: [
      series(
        range,
        'submissions',
        byBucket
          .filter((row) => row.status === 'accepted')
          .map((row) => ({ bucket: row.bucket, value: big(row.value) })),
      ),
    ],
    tables,
  };
};

// ── Automation (automation.workflow.read) ───────────────────────────────────────────────

export const automationReport: ReportRunner = async (tx, ctx, range, options) => {
  const org = ctx.organizationId;
  const byBucket = await rows<{ bucket: string; status: string; value: string }>(
    tx,
    sql`
      select ${bucketOf(range, automationRuns.startedAt)} as bucket, ${automationRuns.status} as status,
             count(*)::text as value
      from ${automationRuns}
      where ${automationRuns.organizationId} = ${org} and ${within(range, automationRuns.startedAt)}
      group by 1, 2`,
  );
  const total = (...statuses: string[]) =>
    byBucket
      .filter((row) => statuses.includes(row.status))
      .reduce((sum, row) => sum + big(row.value), 0n);
  const tables: ReportTable[] = [];
  if (options.detail) {
    const byWorkflow = await rows<{
      workflow: string;
      started: string;
      completed: string;
      failed: string;
    }>(
      tx,
      sql`
        select ${automationWorkflows.name} as workflow, count(*)::text as started,
               count(*) filter (where ${automationRuns.status} = 'completed')::text as completed,
               count(*) filter (where ${automationRuns.status} = 'failed')::text as failed
        from ${automationRuns}
        join ${automationWorkflows} on ${automationWorkflows.id} = ${automationRuns.workflowId}
          and ${automationWorkflows.organizationId} = ${automationRuns.organizationId}
        where ${automationRuns.organizationId} = ${org} and ${within(range, automationRuns.startedAt)}
        group by ${automationWorkflows.id}, ${automationWorkflows.name}
        order by count(*) desc, 1 limit ${TABLE_LIMIT}`,
    );
    tables.push({
      key: 'by_workflow',
      columns: ['workflow', 'started', 'completed', 'failed'],
      rows: byWorkflow.map((row) => [row.workflow, row.started, row.completed, row.failed]),
    });
  }
  const finished = total('completed', 'failed');
  return {
    metrics: [
      count(
        'runs_started',
        total('running', 'waiting', 'completed', 'failed', 'cancelled', 'skipped'),
      ),
      count('runs_completed', total('completed')),
      count('runs_failed', total('failed')),
      { key: 'success_rate', value: percent(total('completed'), finished) ?? '—', currency: null },
    ],
    series: [
      series(
        range,
        'runs_started',
        byBucket.map((row) => ({ bucket: row.bucket, value: big(row.value) })),
      ),
    ],
    tables,
  };
};
