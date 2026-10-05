import { getContact, getDeal, type CrmContext } from '@businessos/crm';
import { organizations, type AutomationRun, type TenantTx } from '@businessos/database';
import { NotFoundError } from '@businessos/shared';
import { eq } from 'drizzle-orm';

/** What templates and conditions can read while a run executes (loaded fresh per step). */
export interface RunContext {
  organization: { name: string; timezone: string };
  contact: {
    id: string;
    firstName: string | null;
    lastName: string | null;
    fullName: string;
    email: string | null;
    phone: string | null;
    whatsappPhone: string | null;
    jobTitle: string | null;
    lifecycleStage: string;
    status: string;
    source: string;
    ownerUserId: string | null;
    tags: string[];
    tagNames: string[];
    custom: Record<string, unknown>;
  } | null;
  deal: {
    id: string;
    name: string;
    pipelineId: string;
    stageId: string;
    status: string;
    ownerUserId: string | null;
    contactId: string | null;
  } | null;
  trigger: Record<string, unknown>;
}

async function orNull<T>(promise: Promise<T>): Promise<T | null> {
  try {
    return await promise;
  } catch (error) {
    if (error instanceof NotFoundError) return null;
    throw error;
  }
}

export async function loadRunContext(
  tx: TenantTx,
  ctx: CrmContext,
  run: Pick<AutomationRun, 'contactId' | 'dealId' | 'triggerData'>,
): Promise<RunContext> {
  const [organization] = await tx
    .select({ name: organizations.name, timezone: organizations.timezone })
    .from(organizations)
    .where(eq(organizations.id, ctx.organizationId));
  const contact = run.contactId ? await orNull(getContact(tx, ctx, run.contactId)) : null;
  const deal = run.dealId ? await orNull(getDeal(tx, ctx, run.dealId)) : null;
  return {
    organization: {
      name: organization?.name ?? '',
      timezone: organization?.timezone ?? 'UTC',
    },
    contact: contact
      ? {
          id: contact.id,
          firstName: contact.firstName,
          lastName: contact.lastName,
          fullName: contact.displayName,
          email: contact.email,
          phone: contact.phone,
          whatsappPhone: contact.whatsappPhone,
          jobTitle: contact.jobTitle,
          lifecycleStage: contact.lifecycleStage,
          status: contact.status,
          source: contact.source,
          ownerUserId: contact.ownerUserId,
          tags: contact.tags.map((tag) => tag.id),
          tagNames: contact.tags.map((tag) => tag.name),
          custom: contact.customFields,
        }
      : null,
    deal: deal
      ? {
          id: deal.id,
          name: deal.name,
          pipelineId: deal.pipelineId,
          stageId: deal.stageId,
          status: deal.status,
          ownerUserId: deal.ownerUserId,
          contactId: deal.contact?.id ?? null,
        }
      : null,
    trigger: run.triggerData,
  };
}

const PATH = /^(organization|contact|deal|trigger)(\.[A-Za-z0-9_]{1,60}){1,5}$/;

/** Reads `contact.firstName`, `contact.custom.size`, `trigger.body.email`… (null when absent). */
export function resolvePath(context: RunContext, path: string): unknown {
  if (!PATH.test(path)) return null;
  let current: unknown = context;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) return null;
    if (!Object.hasOwn(current, segment)) return null;
    current = (current as Record<string, unknown>)[segment];
  }
  return current ?? null;
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return value
      .filter((item) => ['string', 'number', 'boolean'].includes(typeof item))
      .map(String)
      .join(', ');
  }
  return '';
}

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.]{1,200})\s*\}\}/g;

/**
 * Fills `{{contact.firstName}}`-style placeholders. Only plain values are inserted (no code,
 * no nested templates); unknown paths become empty text.
 */
export function renderTemplate(template: string, context: RunContext, maxLength = 10_000): string {
  return template
    .replace(PLACEHOLDER, (_, path: string) => stringify(resolvePath(context, path)))
    .slice(0, maxLength);
}

/** Placeholders used in a template (for validation in the builder). */
export function templatePaths(template: string): string[] {
  return [...template.matchAll(PLACEHOLDER)].map((match) => match[1] ?? '');
}

export function isValidPath(path: string): boolean {
  return PATH.test(path);
}
