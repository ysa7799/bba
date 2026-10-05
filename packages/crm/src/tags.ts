import {
  crmCompanyTags,
  crmContactTags,
  crmDealTags,
  crmTags,
  isUniqueViolation,
  type CrmTag,
  type TenantTx,
} from '@businessos/database';
import { ConflictError, NotFoundError, ValidationError } from '@businessos/shared';
import { and, asc, count, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';

export const TAG_COLORS = [
  'slate',
  'red',
  'orange',
  'amber',
  'green',
  'teal',
  'blue',
  'indigo',
  'purple',
  'pink',
] as const;

export const MAX_TAGS_PER_ORGANIZATION = 500;
export const MAX_TAGS_PER_RECORD = 50;

export const tagInputSchema = z.object({
  name: z.string().trim().min(1).max(50),
  color: z.enum(TAG_COLORS).default('slate'),
});
export const updateTagInputSchema = z
  .object({ name: z.string().trim().min(1).max(50), color: z.enum(TAG_COLORS) })
  .partial();

export const tagIdsSchema = z
  .array(z.uuid())
  .max(MAX_TAGS_PER_RECORD)
  .transform((ids) => [...new Set(ids)]);

export interface TagSummary {
  id: string;
  name: string;
  color: string;
}

export type TaggableEntity = 'contact' | 'company' | 'deal';

function toSummary(tag: CrmTag): TagSummary {
  return { id: tag.id, name: tag.name, color: tag.color };
}

/** Join table and record column for a taggable entity (all three share one shape). */
function joinFor(entity: TaggableEntity) {
  switch (entity) {
    case 'contact':
      return { table: crmContactTags, column: crmContactTags.contactId } as const;
    case 'company':
      return { table: crmCompanyTags, column: crmCompanyTags.companyId } as const;
    case 'deal':
      return { table: crmDealTags, column: crmDealTags.dealId } as const;
  }
}

export async function listTags(tx: TenantTx, organizationId: string): Promise<TagSummary[]> {
  const rows = await tx
    .select()
    .from(crmTags)
    .where(eq(crmTags.organizationId, organizationId))
    .orderBy(asc(sql`lower(${crmTags.name})`), asc(crmTags.id))
    .limit(MAX_TAGS_PER_ORGANIZATION);
  return rows.map(toSummary);
}

function translateTagConflict(error: unknown): never {
  if (isUniqueViolation(error, 'crm_tags_org_name_unique')) {
    throw new ConflictError('A tag with this name already exists', {
      details: [{ path: 'name', message: 'Already exists' }],
    });
  }
  throw error;
}

export async function createTag(
  tx: TenantTx,
  organizationId: string,
  rawInput: z.input<typeof tagInputSchema>,
): Promise<TagSummary> {
  const input = tagInputSchema.parse(rawInput);
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`crm.tags:${organizationId}`}, 0))`,
  );
  const [used] = await tx
    .select({ n: count() })
    .from(crmTags)
    .where(eq(crmTags.organizationId, organizationId));
  if ((used?.n ?? 0) >= MAX_TAGS_PER_ORGANIZATION) {
    throw new ConflictError(`At most ${MAX_TAGS_PER_ORGANIZATION} tags per organization`);
  }
  try {
    const [tag] = await tx
      .insert(crmTags)
      .values({ organizationId, ...input })
      .returning();
    if (!tag) throw new Error('tag insert returned no row');
    return toSummary(tag);
  } catch (error) {
    return translateTagConflict(error);
  }
}

/** Finds tags by name (case-insensitive), creating missing ones (CSV import). */
export async function findOrCreateTags(
  tx: TenantTx,
  organizationId: string,
  names: readonly string[],
): Promise<string[]> {
  const ids: string[] = [];
  for (const name of [...new Set(names.map((n) => n.trim()).filter(Boolean))].slice(
    0,
    MAX_TAGS_PER_RECORD,
  )) {
    const [existing] = await tx
      .select({ id: crmTags.id })
      .from(crmTags)
      .where(
        and(
          eq(crmTags.organizationId, organizationId),
          sql`lower(${crmTags.name}) = lower(${name})`,
        ),
      );
    if (existing) {
      ids.push(existing.id);
      continue;
    }
    const created = await createTag(tx, organizationId, { name: name.slice(0, 50) });
    ids.push(created.id);
  }
  return ids;
}

export async function updateTag(
  tx: TenantTx,
  organizationId: string,
  id: string,
  rawInput: z.input<typeof updateTagInputSchema>,
): Promise<TagSummary> {
  const input = updateTagInputSchema.parse(rawInput);
  try {
    const [tag] = await tx
      .update(crmTags)
      .set(input)
      .where(and(eq(crmTags.id, id), eq(crmTags.organizationId, organizationId)))
      .returning();
    if (!tag) throw new NotFoundError('Tag');
    return toSummary(tag);
  } catch (error) {
    return translateTagConflict(error);
  }
}

/** Deletes a tag and removes it from every record (join rows cascade). */
export async function deleteTag(
  tx: TenantTx,
  organizationId: string,
  id: string,
): Promise<TagSummary> {
  const [tag] = await tx
    .delete(crmTags)
    .where(and(eq(crmTags.id, id), eq(crmTags.organizationId, organizationId)))
    .returning();
  if (!tag) throw new NotFoundError('Tag');
  return toSummary(tag);
}

/** Verifies every id is a tag of this organization (guessed or foreign ids are rejected). */
export async function assertTagsExist(
  tx: TenantTx,
  organizationId: string,
  tagIds: readonly string[],
  path = 'tagIds',
): Promise<void> {
  if (tagIds.length === 0) return;
  const rows = await tx
    .select({ id: crmTags.id })
    .from(crmTags)
    .where(and(eq(crmTags.organizationId, organizationId), inArray(crmTags.id, [...tagIds])));
  if (rows.length !== new Set(tagIds).size) {
    throw new ValidationError('Unknown tag', [{ path, message: 'One or more tags do not exist' }]);
  }
}

/** Tags of many records at once (list views). */
export async function tagsForRecords(
  tx: TenantTx,
  entity: TaggableEntity,
  recordIds: readonly string[],
): Promise<Map<string, TagSummary[]>> {
  const result = new Map<string, TagSummary[]>();
  if (recordIds.length === 0) return result;
  const { table, column } = joinFor(entity);
  const rows = await tx
    .select({ recordId: column, id: crmTags.id, name: crmTags.name, color: crmTags.color })
    .from(table)
    .innerJoin(
      crmTags,
      and(eq(crmTags.id, table.tagId), eq(crmTags.organizationId, table.organizationId)),
    )
    .where(inArray(column, [...recordIds]))
    .orderBy(asc(sql`lower(${crmTags.name})`));
  for (const row of rows) {
    const list = result.get(row.recordId) ?? [];
    list.push({ id: row.id, name: row.name, color: row.color });
    result.set(row.recordId, list);
  }
  return result;
}

/** Adds tags to records; returns the (record, tag) pairs that were newly added. */
export async function addTags(
  tx: TenantTx,
  organizationId: string,
  entity: TaggableEntity,
  recordIds: readonly string[],
  tagIds: readonly string[],
): Promise<{ recordId: string; tagId: string }[]> {
  if (recordIds.length === 0 || tagIds.length === 0) return [];
  await assertTagsExist(tx, organizationId, tagIds);
  const pairs = recordIds.flatMap((recordId) => tagIds.map((tagId) => ({ recordId, tagId })));
  switch (entity) {
    case 'contact':
      return tx
        .insert(crmContactTags)
        .values(pairs.map((p) => ({ organizationId, tagId: p.tagId, contactId: p.recordId })))
        .onConflictDoNothing()
        .returning({ recordId: crmContactTags.contactId, tagId: crmContactTags.tagId });
    case 'company':
      return tx
        .insert(crmCompanyTags)
        .values(pairs.map((p) => ({ organizationId, tagId: p.tagId, companyId: p.recordId })))
        .onConflictDoNothing()
        .returning({ recordId: crmCompanyTags.companyId, tagId: crmCompanyTags.tagId });
    case 'deal':
      return tx
        .insert(crmDealTags)
        .values(pairs.map((p) => ({ organizationId, tagId: p.tagId, dealId: p.recordId })))
        .onConflictDoNothing()
        .returning({ recordId: crmDealTags.dealId, tagId: crmDealTags.tagId });
  }
}

/** Removes tags from records; returns the pairs that were removed. */
export async function removeTags(
  tx: TenantTx,
  organizationId: string,
  entity: TaggableEntity,
  recordIds: readonly string[],
  tagIds: readonly string[],
): Promise<{ recordId: string; tagId: string }[]> {
  if (recordIds.length === 0 || tagIds.length === 0) return [];
  const { table, column } = joinFor(entity);
  return tx
    .delete(table)
    .where(
      and(
        eq(table.organizationId, organizationId),
        inArray(column, [...recordIds]),
        inArray(table.tagId, [...tagIds]),
      ),
    )
    .returning({ recordId: column, tagId: table.tagId });
}

/** Replaces one record's tags; returns what changed. */
export async function setRecordTags(
  tx: TenantTx,
  organizationId: string,
  entity: TaggableEntity,
  recordId: string,
  tagIds: readonly string[],
): Promise<{ added: string[]; removed: string[] }> {
  await assertTagsExist(tx, organizationId, tagIds);
  const current = (await tagsForRecords(tx, entity, [recordId])).get(recordId) ?? [];
  const currentIds = new Set(current.map((tag) => tag.id));
  const wanted = new Set(tagIds);
  const toAdd = [...wanted].filter((id) => !currentIds.has(id));
  const toRemove = [...currentIds].filter((id) => !wanted.has(id));
  const added = await addTags(tx, organizationId, entity, [recordId], toAdd);
  const removed = await removeTags(tx, organizationId, entity, [recordId], toRemove);
  return { added: added.map((pair) => pair.tagId), removed: removed.map((pair) => pair.tagId) };
}
