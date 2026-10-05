import { crmNotes, users, type CrmNote, type TenantTx } from '@businessos/database';
import { emitEvent } from '@businessos/events';
import {
  ForbiddenError,
  NotFoundError,
  paginationQuerySchema,
  ValidationError,
  type Page,
} from '@businessos/shared';
import { and, eq, isNull, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { eventMeta, type CrmContext } from './context';
import { afterCursor, keysetPage, orderFor, sortValue, type SortSpec } from './listing';
import { assertCompanyExists, assertContactExists, assertDealExists } from './records';

export type NoteParentType = 'contact' | 'company' | 'deal';

export interface NoteParent {
  type: NoteParentType;
  id: string;
}

export const noteBodySchema = z.object({ body: z.string().trim().min(1).max(20_000) });
export const noteListQuerySchema = paginationQuerySchema;

export interface NoteSummary {
  id: string;
  body: string;
  parent: NoteParent;
  authorUserId: string | null;
  authorName: string | null;
  edited: boolean;
  createdAt: string;
  updatedAt: string;
}

const spec: SortSpec = {
  name: 'created_desc',
  expression: crmNotes.createdAt,
  direction: 'desc',
  kind: 'timestamp',
};

export function noteParent(note: Pick<CrmNote, 'contactId' | 'companyId' | 'dealId'>): NoteParent {
  if (note.contactId) return { type: 'contact', id: note.contactId };
  if (note.companyId) return { type: 'company', id: note.companyId };
  if (note.dealId) return { type: 'deal', id: note.dealId };
  throw new Error('note without parent');
}

function parentCondition(parent: NoteParent): SQL {
  switch (parent.type) {
    case 'contact':
      return eq(crmNotes.contactId, parent.id);
    case 'company':
      return eq(crmNotes.companyId, parent.id);
    case 'deal':
      return eq(crmNotes.dealId, parent.id);
  }
}

async function assertParent(
  tx: TenantTx,
  organizationId: string,
  parent: NoteParent,
): Promise<void> {
  switch (parent.type) {
    case 'contact':
      return assertContactExists(tx, organizationId, parent.id).catch((error: unknown) => {
        throw error instanceof ValidationError ? new NotFoundError('Contact') : error;
      });
    case 'company':
      return assertCompanyExists(tx, organizationId, parent.id).catch((error: unknown) => {
        throw error instanceof ValidationError ? new NotFoundError('Company') : error;
      });
    case 'deal':
      return assertDealExists(tx, organizationId, parent.id).catch((error: unknown) => {
        throw error instanceof ValidationError ? new NotFoundError('Deal') : error;
      });
  }
}

function toSummary(note: CrmNote, authorName: string | null): NoteSummary {
  return {
    id: note.id,
    body: note.body,
    parent: noteParent(note),
    authorUserId: note.authorUserId,
    authorName: note.authorUserId === null ? null : authorName,
    edited: note.updatedAt.getTime() - note.createdAt.getTime() > 1_000,
    createdAt: note.createdAt.toISOString(),
    updatedAt: note.updatedAt.toISOString(),
  };
}

export async function listNotes(
  tx: TenantTx,
  ctx: CrmContext,
  parent: NoteParent,
  query: z.infer<typeof noteListQuerySchema>,
): Promise<Page<NoteSummary>> {
  await assertParent(tx, ctx.organizationId, parent);
  const conditions: SQL[] = [
    eq(crmNotes.organizationId, ctx.organizationId),
    isNull(crmNotes.deletedAt),
    parentCondition(parent),
  ];
  const after = afterCursor(spec, crmNotes.id, query.cursor);
  if (after) conditions.push(after);
  const rows = await tx
    .select({ note: crmNotes, authorName: users.name, id: crmNotes.id, sortValue: sortValue(spec) })
    .from(crmNotes)
    .leftJoin(users, eq(users.id, crmNotes.authorUserId))
    .where(and(...conditions))
    .orderBy(...orderFor(spec, crmNotes.id))
    .limit(query.limit + 1);
  return keysetPage(spec, rows, query.limit, (row) => toSummary(row.note, row.authorName));
}

export async function createNote(
  tx: TenantTx,
  ctx: CrmContext,
  parent: NoteParent,
  rawInput: z.input<typeof noteBodySchema>,
): Promise<NoteSummary> {
  const { body } = noteBodySchema.parse(rawInput);
  await assertParent(tx, ctx.organizationId, parent);
  const [note] = await tx
    .insert(crmNotes)
    .values({
      organizationId: ctx.organizationId,
      body,
      contactId: parent.type === 'contact' ? parent.id : null,
      companyId: parent.type === 'company' ? parent.id : null,
      dealId: parent.type === 'deal' ? parent.id : null,
      authorUserId: ctx.actor.userId,
    })
    .returning();
  if (!note) throw new Error('note insert returned no row');
  await emitEvent(tx, {
    ...eventMeta(ctx),
    type: 'note.created',
    subject: { type: 'note', id: note.id },
    payload: { noteId: note.id, parentType: parent.type, parentId: parent.id },
  });
  return getNote(tx, ctx, note.id);
}

export async function getNote(tx: TenantTx, ctx: CrmContext, id: string): Promise<NoteSummary> {
  const [row] = await tx
    .select({ note: crmNotes, authorName: users.name })
    .from(crmNotes)
    .leftJoin(users, eq(users.id, crmNotes.authorUserId))
    .where(
      and(
        eq(crmNotes.id, id),
        eq(crmNotes.organizationId, ctx.organizationId),
        isNull(crmNotes.deletedAt),
      ),
    );
  if (!row) throw new NotFoundError('Note');
  return toSummary(row.note, row.authorName);
}

/** Authors may change their own notes; `canModerate` (crm.note.manage) allows anyone's. */
function assertCanChange(ctx: CrmContext, note: NoteSummary, canModerate: boolean): void {
  if (canModerate) return;
  if (ctx.actor.userId === null || note.authorUserId !== ctx.actor.userId) {
    throw new ForbiddenError('You can only change your own notes');
  }
}

export async function updateNote(
  tx: TenantTx,
  ctx: CrmContext,
  id: string,
  rawInput: z.input<typeof noteBodySchema>,
  options: { canModerate: boolean },
): Promise<NoteSummary> {
  const { body } = noteBodySchema.parse(rawInput);
  const note = await getNote(tx, ctx, id);
  assertCanChange(ctx, note, options.canModerate);
  await tx
    .update(crmNotes)
    .set({ body })
    .where(and(eq(crmNotes.id, id), eq(crmNotes.organizationId, ctx.organizationId)));
  return getNote(tx, ctx, id);
}

export async function deleteNote(
  tx: TenantTx,
  ctx: CrmContext,
  id: string,
  options: { canModerate: boolean },
): Promise<NoteSummary> {
  const note = await getNote(tx, ctx, id);
  assertCanChange(ctx, note, options.canModerate);
  await tx
    .update(crmNotes)
    .set({ deletedAt: new Date() })
    .where(and(eq(crmNotes.id, id), eq(crmNotes.organizationId, ctx.organizationId)));
  return note;
}
