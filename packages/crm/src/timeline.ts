import type { ActivityProjector, ProjectorMap } from '@businessos/activities';
import {
  crmCompanies,
  crmContactCompanies,
  crmDeals,
  crmNotes,
  crmPipelines,
  crmPipelineStages,
  crmTags,
  crmTasks,
  type TenantTx,
} from '@businessos/database';
import type { DomainEvent, EventPayload, EventType } from '@businessos/events';
import { formatDecimal, isCurrencyCode, money } from '@businessos/shared';
import { and, eq } from 'drizzle-orm';

/*
 * Timeline projectors for CRM events. They run in the event's tenant transaction (worker) and
 * snapshot names into the summary/metadata, so the timeline still reads correctly after records
 * are renamed or deleted. Records are loaded even when soft-deleted.
 */

function payload<T extends EventType>(event: DomainEvent, _type: T): EventPayload<T> {
  return event.payload as EventPayload<T>;
}

const FIELD_LABELS: Record<string, string> = {
  firstName: 'first name',
  lastName: 'last name',
  whatsappPhone: 'WhatsApp number',
  jobTitle: 'job title',
  lifecycleStage: 'lifecycle stage',
  ownerUserId: 'owner',
  customFields: 'custom fields',
  employeeCount: 'employees',
  countryCode: 'country',
  expectedCloseDate: 'expected close date',
  contactId: 'contact',
  companyId: 'company',
  stageId: 'stage',
  lostReason: 'lost reason',
};

function fieldList(fields: readonly string[]): string {
  return fields.map((field) => FIELD_LABELS[field] ?? field).join(', ');
}

async function primaryCompanyId(tx: TenantTx, contactId: string): Promise<string | null> {
  const [row] = await tx
    .select({ companyId: crmContactCompanies.companyId })
    .from(crmContactCompanies)
    .where(
      and(eq(crmContactCompanies.contactId, contactId), eq(crmContactCompanies.isPrimary, true)),
    );
  return row?.companyId ?? null;
}

async function loadDeal(tx: TenantTx, dealId: string) {
  const [row] = await tx
    .select({
      deal: crmDeals,
      pipelineName: crmPipelines.name,
      stageName: crmPipelineStages.name,
    })
    .from(crmDeals)
    .innerJoin(crmPipelines, eq(crmPipelines.id, crmDeals.pipelineId))
    .innerJoin(crmPipelineStages, eq(crmPipelineStages.id, crmDeals.stageId))
    .where(eq(crmDeals.id, dealId));
  return row ?? null;
}

async function stageName(tx: TenantTx, stageId: string): Promise<string> {
  const [row] = await tx
    .select({ name: crmPipelineStages.name })
    .from(crmPipelineStages)
    .where(eq(crmPipelineStages.id, stageId));
  return row?.name ?? 'a deleted stage';
}

function moneyText(valueMinor: bigint | string | null, currency: string): string | null {
  if (valueMinor === null || !isCurrencyCode(currency)) return null;
  return `${currency} ${formatDecimal(money(BigInt(valueMinor), currency))}`;
}

function moneyJson(valueMinor: bigint | null, currency: string) {
  if (valueMinor === null || !isCurrencyCode(currency)) return null;
  return { amount: formatDecimal(money(valueMinor, currency)), currency };
}

/** Links for a deal: the deal and, through it, its contact and company. */
function dealLinks(deal: { id: string; contactId: string | null; companyId: string | null }) {
  return { dealId: deal.id, contactId: deal.contactId, companyId: deal.companyId };
}

const contactCreated: ActivityProjector = async (tx, event) => {
  const { contactId, source } = payload(event, 'contact.created');
  return {
    type: 'contact.created',
    subject: { type: 'contact', id: contactId },
    contactId,
    companyId: await primaryCompanyId(tx, contactId),
    summary: source === 'manual' ? 'Contact created' : `Contact created (source: ${source})`,
    metadata: { source },
  };
};

const contactUpdated: ActivityProjector = async (tx, event) => {
  const { contactId, changedFields } = payload(event, 'contact.updated');
  // Tag changes have their own activities.
  const fields = changedFields.filter((field) => field !== 'tags');
  if (fields.length === 0) return null;
  return {
    type: 'contact.updated',
    subject: { type: 'contact', id: contactId },
    contactId,
    companyId: await primaryCompanyId(tx, contactId),
    summary: `Contact updated: ${fieldList(fields)}`,
    metadata: { changedFields: fields },
  };
};

function contactTag(type: 'contact.tagged' | 'contact.untagged'): ActivityProjector {
  return async (tx, event) => {
    const { contactId, tagId } = payload(
      event,
      type === 'contact.tagged' ? 'contact.tag_added' : 'contact.tag_removed',
    );
    const [tag] = await tx
      .select({ name: crmTags.name })
      .from(crmTags)
      .where(eq(crmTags.id, tagId));
    const name = tag?.name ?? 'a deleted tag';
    return {
      type,
      subject: { type: 'contact', id: contactId },
      contactId,
      summary: type === 'contact.tagged' ? `Tagged “${name}”` : `Tag “${name}” removed`,
      metadata: { tag: name },
    };
  };
}

const companyCreated: ActivityProjector = async (tx, event) => {
  const { companyId } = payload(event, 'company.created');
  const [company] = await tx
    .select({ name: crmCompanies.name })
    .from(crmCompanies)
    .where(eq(crmCompanies.id, companyId));
  if (!company) return null;
  return {
    type: 'company.created',
    subject: { type: 'company', id: companyId },
    companyId,
    summary: `Company created: ${company.name}`,
  };
};

const companyUpdated: ActivityProjector = (_tx, event) => {
  const { companyId, changedFields } = payload(event, 'company.updated');
  const fields = changedFields.filter((field) => field !== 'tags');
  if (fields.length === 0) return Promise.resolve(null);
  return Promise.resolve({
    type: 'company.updated',
    subject: { type: 'company', id: companyId },
    companyId,
    summary: `Company updated: ${fieldList(fields)}`,
    metadata: { changedFields: fields },
  });
};

const dealCreated: ActivityProjector = async (tx, event) => {
  const { dealId } = payload(event, 'deal.created');
  const row = await loadDeal(tx, dealId);
  if (!row) return null;
  const value = moneyText(row.deal.valueMinor, row.deal.currency);
  return {
    type: 'deal.created',
    subject: { type: 'deal', id: dealId },
    ...dealLinks(row.deal),
    summary: `Deal created: ${row.deal.name}${value ? ` · ${value}` : ''}`,
    metadata: {
      dealName: row.deal.name,
      pipeline: row.pipelineName,
      stage: row.stageName,
      value: moneyJson(row.deal.valueMinor, row.deal.currency),
    },
  };
};

const dealUpdated: ActivityProjector = async (tx, event) => {
  const { dealId, changedFields } = payload(event, 'deal.updated');
  const fields = changedFields.filter((field) => field !== 'tags');
  if (fields.length === 0) return null;
  const row = await loadDeal(tx, dealId);
  if (!row) return null;
  return {
    type: 'deal.updated',
    subject: { type: 'deal', id: dealId },
    ...dealLinks(row.deal),
    summary: `Deal updated: ${row.deal.name} (${fieldList(fields)})`,
    metadata: { dealName: row.deal.name, changedFields: fields },
  };
};

const dealStageChanged: ActivityProjector = async (tx, event) => {
  const { dealId, fromStageId, toStageId } = payload(event, 'deal.stage_changed');
  const row = await loadDeal(tx, dealId);
  if (!row) return null;
  const [fromStage, toStage] = [await stageName(tx, fromStageId), await stageName(tx, toStageId)];
  return {
    type: 'deal.stage_changed',
    subject: { type: 'deal', id: dealId },
    ...dealLinks(row.deal),
    summary: `${row.deal.name} moved from ${fromStage} to ${toStage}`,
    metadata: { dealName: row.deal.name, fromStage, toStage },
  };
};

const dealWon: ActivityProjector = async (tx, event) => {
  const { dealId, valueMinor, currency } = payload(event, 'deal.won');
  const row = await loadDeal(tx, dealId);
  if (!row) return null;
  const value = moneyText(valueMinor, currency);
  return {
    type: 'deal.won',
    subject: { type: 'deal', id: dealId },
    ...dealLinks(row.deal),
    summary: `Deal won: ${row.deal.name}${value ? ` · ${value}` : ''}`,
    metadata: {
      dealName: row.deal.name,
      value: valueMinor === null ? null : moneyJson(BigInt(valueMinor), currency),
    },
  };
};

const dealLost: ActivityProjector = async (tx, event) => {
  const { dealId, lostReason } = payload(event, 'deal.lost');
  const row = await loadDeal(tx, dealId);
  if (!row) return null;
  return {
    type: 'deal.lost',
    subject: { type: 'deal', id: dealId },
    ...dealLinks(row.deal),
    summary: `Deal lost: ${row.deal.name}${lostReason ? ` — ${lostReason}` : ''}`,
    metadata: { dealName: row.deal.name, lostReason },
  };
};

const dealDeleted: ActivityProjector = async (tx, event) => {
  const { dealId } = payload(event, 'deal.deleted');
  const row = await loadDeal(tx, dealId);
  if (!row) return null;
  return {
    type: 'deal.deleted',
    subject: { type: 'deal', id: dealId },
    ...dealLinks(row.deal),
    summary: `Deal deleted: ${row.deal.name}`,
    metadata: { dealName: row.deal.name },
  };
};

function taskProjector(type: 'task.created' | 'task.completed'): ActivityProjector {
  return async (tx, event) => {
    const { taskId } = payload(event, type);
    const [task] = await tx.select().from(crmTasks).where(eq(crmTasks.id, taskId));
    if (!task || (!task.contactId && !task.companyId && !task.dealId)) return null;
    return {
      type,
      subject: { type: 'task', id: taskId },
      contactId: task.contactId,
      companyId: task.companyId,
      dealId: task.dealId,
      summary: `${type === 'task.created' ? 'Task created' : 'Task completed'}: ${task.title}`,
      metadata: { title: task.title, dueAt: task.dueAt?.toISOString() ?? null },
    };
  };
}

const noteCreated: ActivityProjector = async (tx, event) => {
  const { noteId, parentType, parentId } = payload(event, 'note.created');
  const [note] = await tx
    .select({ body: crmNotes.body })
    .from(crmNotes)
    .where(eq(crmNotes.id, noteId));
  if (!note) return null;
  const excerpt = note.body.replace(/\s+/g, ' ').trim().slice(0, 280);
  const base = {
    type: 'note.created' as const,
    subject: { type: 'note', id: noteId },
    summary: excerpt,
    metadata: { excerpt },
  };
  switch (parentType) {
    case 'contact':
      return {
        ...base,
        contactId: parentId,
        companyId: await primaryCompanyId(tx, parentId),
        requiredPermission: 'crm.contact.read',
      };
    case 'company':
      return { ...base, companyId: parentId, requiredPermission: 'crm.company.read' };
    case 'deal': {
      const row = await loadDeal(tx, parentId);
      return {
        ...base,
        dealId: parentId,
        contactId: row?.deal.contactId ?? null,
        companyId: row?.deal.companyId ?? null,
        requiredPermission: 'crm.deal.read',
      };
    }
  }
};

export const crmTimelineProjectors: ProjectorMap = {
  'contact.created': contactCreated,
  'contact.updated': contactUpdated,
  'contact.tag_added': contactTag('contact.tagged'),
  'contact.tag_removed': contactTag('contact.untagged'),
  'company.created': companyCreated,
  'company.updated': companyUpdated,
  'deal.created': dealCreated,
  'deal.updated': dealUpdated,
  'deal.stage_changed': dealStageChanged,
  'deal.won': dealWon,
  'deal.lost': dealLost,
  'deal.deleted': dealDeleted,
  'task.created': taskProjector('task.created'),
  'task.completed': taskProjector('task.completed'),
  'note.created': noteCreated,
};
