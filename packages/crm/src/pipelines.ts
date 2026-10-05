import { getLimit } from '@businessos/billing';
import {
  crmDeals,
  crmPipelines,
  crmPipelineStages,
  isUniqueViolation,
  STAGE_KINDS,
  type CrmPipeline,
  type CrmPipelineStage,
  type TenantTx,
} from '@businessos/database';
import { ConflictError, NotFoundError, ValidationError } from '@businessos/shared';
import { and, asc, count, eq, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { assertPipelineCapacity, lockPipelines } from './limits';

export const MAX_STAGES_PER_PIPELINE = 30;

export const DEFAULT_PIPELINE_NAME = 'Sales pipeline';
export const DEFAULT_STAGES = [
  { name: 'Lead', probability: 10, kind: 'open' },
  { name: 'Qualified', probability: 25, kind: 'open' },
  { name: 'Proposal', probability: 50, kind: 'open' },
  { name: 'Negotiation', probability: 75, kind: 'open' },
  { name: 'Won', probability: 100, kind: 'won' },
  { name: 'Lost', probability: 0, kind: 'lost' },
] as const;

export const stageInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  probability: z.number().int().min(0).max(100).optional(),
  kind: z.enum(STAGE_KINDS).default('open'),
});

function uniqueNames(stages: readonly { name: string }[]): boolean {
  return new Set(stages.map((stage) => stage.name.toLowerCase())).size === stages.length;
}

export const createPipelineInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  isDefault: z.boolean().default(false),
  stages: z
    .array(stageInputSchema)
    .min(1)
    .max(MAX_STAGES_PER_PIPELINE)
    .refine((stages) => stages.some((stage) => stage.kind === 'open'), {
      message: 'Add at least one open stage',
    })
    .refine(uniqueNames, { message: 'Stage names must be unique' })
    .optional(),
});

export const updatePipelineInputSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    /** Only `true`: another pipeline stops being the default. */
    isDefault: z.literal(true),
    position: z.number().int().min(0).max(1_000),
  })
  .partial();

export const updateStageInputSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    probability: z.number().int().min(0).max(100),
    kind: z.enum(STAGE_KINDS),
  })
  .partial();

export const reorderStagesInputSchema = z.object({
  stageIds: z.array(z.uuid()).min(1).max(MAX_STAGES_PER_PIPELINE),
});

export interface StageSummary {
  id: string;
  name: string;
  position: number;
  probability: number;
  kind: CrmPipelineStage['kind'];
}

export interface PipelineDetail {
  id: string;
  name: string;
  isDefault: boolean;
  position: number;
  archived: boolean;
  stages: StageSummary[];
}

function defaultProbability(kind: CrmPipelineStage['kind']): number {
  return kind === 'won' ? 100 : 0;
}

function toStage(stage: CrmPipelineStage): StageSummary {
  return {
    id: stage.id,
    name: stage.name,
    position: stage.position,
    probability: stage.probability,
    kind: stage.kind,
  };
}

async function stagesOf(tx: TenantTx, pipelineId: string): Promise<CrmPipelineStage[]> {
  return tx
    .select()
    .from(crmPipelineStages)
    .where(eq(crmPipelineStages.pipelineId, pipelineId))
    .orderBy(asc(crmPipelineStages.position), asc(crmPipelineStages.id));
}

function toDetail(pipeline: CrmPipeline, stages: CrmPipelineStage[]): PipelineDetail {
  return {
    id: pipeline.id,
    name: pipeline.name,
    isDefault: pipeline.isDefault,
    position: pipeline.position,
    archived: pipeline.archivedAt !== null,
    stages: stages.map(toStage),
  };
}

function translateNameConflict(error: unknown): never {
  if (isUniqueViolation(error, 'crm_pipelines_org_name_unique')) {
    throw new ConflictError('A pipeline with this name already exists', {
      details: [{ path: 'name', message: 'Already exists' }],
    });
  }
  if (isUniqueViolation(error, 'crm_pipeline_stages_pipeline_name_unique')) {
    throw new ConflictError('A stage with this name already exists in the pipeline', {
      details: [{ path: 'name', message: 'Already exists' }],
    });
  }
  throw error;
}

async function insertPipeline(
  tx: TenantTx,
  organizationId: string,
  input: {
    name: string;
    isDefault: boolean;
    position: number;
    stages: readonly {
      name: string;
      probability?: number | undefined;
      kind: CrmPipelineStage['kind'];
    }[];
  },
): Promise<PipelineDetail> {
  let pipeline: CrmPipeline | undefined;
  try {
    [pipeline] = await tx
      .insert(crmPipelines)
      .values({
        organizationId,
        name: input.name,
        isDefault: input.isDefault,
        position: input.position,
      })
      .returning();
  } catch (error) {
    translateNameConflict(error);
  }
  if (!pipeline) throw new Error('pipeline insert returned no row');
  const stages = await tx
    .insert(crmPipelineStages)
    .values(
      input.stages.map((stage, index) => ({
        organizationId,
        pipelineId: pipeline.id,
        name: stage.name,
        position: index,
        probability: stage.probability ?? defaultProbability(stage.kind),
        kind: stage.kind,
      })),
    )
    .returning();
  stages.sort((a, b) => a.position - b.position);
  return toDetail(pipeline, stages);
}

/**
 * Every organization gets a ready-to-use pipeline the first time CRM pipelines are read (when
 * its plan allows at least one). Serialized per organization, so concurrent first requests
 * create exactly one.
 */
export async function ensureDefaultPipeline(tx: TenantTx, organizationId: string): Promise<void> {
  const exists = async () => {
    const [row] = await tx
      .select({ id: crmPipelines.id })
      .from(crmPipelines)
      .where(and(eq(crmPipelines.organizationId, organizationId), isNull(crmPipelines.archivedAt)))
      .limit(1);
    return row !== undefined;
  };
  if (await exists()) return;
  await lockPipelines(tx, organizationId);
  if (await exists()) return;
  const limit = await getLimit(tx, organizationId, 'crm.pipelines.max');
  if (limit !== null && limit < 1) return;
  await insertPipeline(tx, organizationId, {
    name: DEFAULT_PIPELINE_NAME,
    isDefault: true,
    position: 0,
    stages: DEFAULT_STAGES,
  });
}

export async function listPipelines(
  tx: TenantTx,
  organizationId: string,
): Promise<PipelineDetail[]> {
  await ensureDefaultPipeline(tx, organizationId);
  const pipelines = await tx
    .select()
    .from(crmPipelines)
    .where(and(eq(crmPipelines.organizationId, organizationId), isNull(crmPipelines.archivedAt)))
    .orderBy(asc(crmPipelines.position), asc(crmPipelines.createdAt))
    .limit(100);
  const stages = await tx
    .select()
    .from(crmPipelineStages)
    .where(eq(crmPipelineStages.organizationId, organizationId))
    .orderBy(asc(crmPipelineStages.position), asc(crmPipelineStages.id));
  return pipelines.map((pipeline) =>
    toDetail(
      pipeline,
      stages.filter((stage) => stage.pipelineId === pipeline.id),
    ),
  );
}

async function findPipeline(
  tx: TenantTx,
  organizationId: string,
  id: string,
  options: { includeArchived?: boolean; lock?: boolean } = {},
): Promise<CrmPipeline> {
  const conditions = [eq(crmPipelines.id, id), eq(crmPipelines.organizationId, organizationId)];
  if (!options.includeArchived) conditions.push(isNull(crmPipelines.archivedAt));
  const query = tx
    .select()
    .from(crmPipelines)
    .where(and(...conditions));
  const [pipeline] = options.lock ? await query.for('update') : await query;
  if (!pipeline) throw new NotFoundError('Pipeline');
  return pipeline;
}

export async function getPipeline(
  tx: TenantTx,
  organizationId: string,
  id: string,
  options: { includeArchived?: boolean } = {},
): Promise<PipelineDetail> {
  const pipeline = await findPipeline(tx, organizationId, id, options);
  return toDetail(pipeline, await stagesOf(tx, id));
}

/** The default pipeline (created on demand). */
export async function defaultPipeline(
  tx: TenantTx,
  organizationId: string,
): Promise<PipelineDetail> {
  await ensureDefaultPipeline(tx, organizationId);
  const [pipeline] = await tx
    .select()
    .from(crmPipelines)
    .where(and(eq(crmPipelines.organizationId, organizationId), isNull(crmPipelines.archivedAt)))
    .orderBy(
      sql`${crmPipelines.isDefault} desc`,
      asc(crmPipelines.position),
      asc(crmPipelines.createdAt),
    )
    .limit(1);
  if (!pipeline) {
    throw new ValidationError('No pipeline available', [
      { path: 'pipelineId', message: 'Create a pipeline first' },
    ]);
  }
  return toDetail(pipeline, await stagesOf(tx, pipeline.id));
}

async function clearDefault(tx: TenantTx, organizationId: string, exceptId: string): Promise<void> {
  await tx
    .update(crmPipelines)
    .set({ isDefault: false })
    .where(
      and(
        eq(crmPipelines.organizationId, organizationId),
        eq(crmPipelines.isDefault, true),
        ne(crmPipelines.id, exceptId),
      ),
    );
}

export async function createPipeline(
  tx: TenantTx,
  organizationId: string,
  rawInput: z.input<typeof createPipelineInputSchema>,
): Promise<PipelineDetail> {
  const input = createPipelineInputSchema.parse(rawInput);
  await assertPipelineCapacity(tx, organizationId);
  const [hasActive] = await tx
    .select({ n: count() })
    .from(crmPipelines)
    .where(and(eq(crmPipelines.organizationId, organizationId), isNull(crmPipelines.archivedAt)));
  const makeDefault = input.isDefault || (hasActive?.n ?? 0) === 0;
  if (makeDefault) {
    await tx
      .update(crmPipelines)
      .set({ isDefault: false })
      .where(
        and(eq(crmPipelines.organizationId, organizationId), eq(crmPipelines.isDefault, true)),
      );
  }
  return insertPipeline(tx, organizationId, {
    name: input.name,
    isDefault: makeDefault,
    position: hasActive?.n ?? 0,
    stages: input.stages ?? DEFAULT_STAGES,
  });
}

export async function updatePipeline(
  tx: TenantTx,
  organizationId: string,
  id: string,
  rawInput: z.input<typeof updatePipelineInputSchema>,
): Promise<{ before: PipelineDetail; after: PipelineDetail }> {
  const input = updatePipelineInputSchema.parse(rawInput);
  const pipeline = await findPipeline(tx, organizationId, id, { lock: true });
  const before = toDetail(pipeline, await stagesOf(tx, id));
  if (input.isDefault) await clearDefault(tx, organizationId, id);
  try {
    await tx
      .update(crmPipelines)
      .set(input)
      .where(and(eq(crmPipelines.id, id), eq(crmPipelines.organizationId, organizationId)));
  } catch (error) {
    translateNameConflict(error);
  }
  return { before, after: await getPipeline(tx, organizationId, id) };
}

async function liveDealCount(
  tx: TenantTx,
  where: ReturnType<typeof eq>,
  options: { openOnly?: boolean } = {},
): Promise<number> {
  const conditions = [where, isNull(crmDeals.deletedAt)];
  if (options.openOnly) conditions.push(eq(crmDeals.status, 'open'));
  const [row] = await tx
    .select({ n: count() })
    .from(crmDeals)
    .where(and(...conditions));
  return row?.n ?? 0;
}

/** Archives a pipeline: not the default one, and only once it has no open deals. */
export async function archivePipeline(
  tx: TenantTx,
  organizationId: string,
  id: string,
): Promise<PipelineDetail> {
  const pipeline = await findPipeline(tx, organizationId, id, { lock: true });
  if (pipeline.isDefault) {
    throw new ConflictError('Make another pipeline the default before archiving this one');
  }
  if ((await liveDealCount(tx, eq(crmDeals.pipelineId, id), { openOnly: true })) > 0) {
    throw new ConflictError('Close or move the open deals in this pipeline first');
  }
  await tx
    .update(crmPipelines)
    .set({ archivedAt: new Date() })
    .where(and(eq(crmPipelines.id, id), eq(crmPipelines.organizationId, organizationId)));
  return getPipeline(tx, organizationId, id, { includeArchived: true });
}

async function findStage(
  tx: TenantTx,
  organizationId: string,
  pipelineId: string,
  stageId: string,
): Promise<CrmPipelineStage> {
  const [stage] = await tx
    .select()
    .from(crmPipelineStages)
    .where(
      and(
        eq(crmPipelineStages.id, stageId),
        eq(crmPipelineStages.pipelineId, pipelineId),
        eq(crmPipelineStages.organizationId, organizationId),
      ),
    );
  if (!stage) throw new NotFoundError('Stage');
  return stage;
}

export async function addStage(
  tx: TenantTx,
  organizationId: string,
  pipelineId: string,
  rawInput: z.input<typeof stageInputSchema>,
): Promise<PipelineDetail> {
  const input = stageInputSchema.parse(rawInput);
  await findPipeline(tx, organizationId, pipelineId, { lock: true });
  const stages = await stagesOf(tx, pipelineId);
  if (stages.length >= MAX_STAGES_PER_PIPELINE) {
    throw new ConflictError(`A pipeline can have at most ${MAX_STAGES_PER_PIPELINE} stages`);
  }
  // New open stages go before the closing (won/lost) stages; closing stages go last.
  const firstClosing = stages.findIndex((stage) => stage.kind !== 'open');
  const insertAt = input.kind === 'open' && firstClosing !== -1 ? firstClosing : stages.length;
  for (const [index, stage] of stages.entries()) {
    const position = index >= insertAt ? index + 1 : index;
    if (stage.position !== position) {
      await tx
        .update(crmPipelineStages)
        .set({ position })
        .where(eq(crmPipelineStages.id, stage.id));
    }
  }
  try {
    await tx.insert(crmPipelineStages).values({
      organizationId,
      pipelineId,
      name: input.name,
      position: insertAt,
      probability: input.probability ?? defaultProbability(input.kind),
      kind: input.kind,
    });
  } catch (error) {
    translateNameConflict(error);
  }
  return getPipeline(tx, organizationId, pipelineId);
}

export async function updateStage(
  tx: TenantTx,
  organizationId: string,
  pipelineId: string,
  stageId: string,
  rawInput: z.input<typeof updateStageInputSchema>,
): Promise<PipelineDetail> {
  const input = updateStageInputSchema.parse(rawInput);
  await findPipeline(tx, organizationId, pipelineId, { lock: true });
  const stage = await findStage(tx, organizationId, pipelineId, stageId);
  if (input.kind !== undefined && input.kind !== stage.kind) {
    // Deal status follows the stage kind; changing it under existing deals would desync them.
    if ((await liveDealCount(tx, eq(crmDeals.stageId, stageId))) > 0) {
      throw new ConflictError('Move the deals out of this stage before changing its type');
    }
    if (stage.kind === 'open') {
      const stages = await stagesOf(tx, pipelineId);
      if (stages.filter((s) => s.kind === 'open').length <= 1) {
        throw new ConflictError('A pipeline needs at least one open stage');
      }
    }
  }
  try {
    await tx.update(crmPipelineStages).set(input).where(eq(crmPipelineStages.id, stageId));
  } catch (error) {
    translateNameConflict(error);
  }
  return getPipeline(tx, organizationId, pipelineId);
}

export async function deleteStage(
  tx: TenantTx,
  organizationId: string,
  pipelineId: string,
  stageId: string,
): Promise<PipelineDetail> {
  await findPipeline(tx, organizationId, pipelineId, { lock: true });
  const stage = await findStage(tx, organizationId, pipelineId, stageId);
  const stages = await stagesOf(tx, pipelineId);
  const remaining = stages.filter((s) => s.id !== stageId);
  if (remaining.length === 0 || !remaining.some((s) => s.kind === 'open')) {
    throw new ConflictError('A pipeline needs at least one open stage');
  }
  if ((await liveDealCount(tx, eq(crmDeals.stageId, stageId))) > 0) {
    throw new ConflictError('Move the deals out of this stage before deleting it');
  }
  // Deleted deals still reference the stage; park them on a surviving stage of the same kind.
  const fallback = remaining.find((s) => s.kind === stage.kind) ?? remaining[0];
  if (fallback) {
    await tx
      .update(crmDeals)
      .set({ stageId: fallback.id })
      .where(and(eq(crmDeals.stageId, stageId), isNotNull(crmDeals.deletedAt)));
  }
  await tx.delete(crmPipelineStages).where(eq(crmPipelineStages.id, stageId));
  for (const [index, s] of remaining.entries()) {
    if (s.position !== index) {
      await tx
        .update(crmPipelineStages)
        .set({ position: index })
        .where(eq(crmPipelineStages.id, s.id));
    }
  }
  return getPipeline(tx, organizationId, pipelineId);
}

export async function reorderStages(
  tx: TenantTx,
  organizationId: string,
  pipelineId: string,
  rawInput: z.input<typeof reorderStagesInputSchema>,
): Promise<PipelineDetail> {
  const { stageIds } = reorderStagesInputSchema.parse(rawInput);
  await findPipeline(tx, organizationId, pipelineId, { lock: true });
  const stages = await stagesOf(tx, pipelineId);
  const current = new Set(stages.map((stage) => stage.id));
  if (
    stageIds.length !== current.size ||
    new Set(stageIds).size !== stageIds.length ||
    !stageIds.every((id) => current.has(id))
  ) {
    throw new ValidationError('Invalid stage order', [
      { path: 'stageIds', message: 'Must list every stage of the pipeline exactly once' },
    ]);
  }
  for (const [index, id] of stageIds.entries()) {
    await tx.update(crmPipelineStages).set({ position: index }).where(eq(crmPipelineStages.id, id));
  }
  return getPipeline(tx, organizationId, pipelineId);
}

/** Resolves a stage for a deal: it must belong to the given live pipeline of this tenant. */
export async function resolveStage(
  tx: TenantTx,
  organizationId: string,
  pipelineId: string,
  stageId: string | undefined,
): Promise<CrmPipelineStage> {
  await findPipeline(tx, organizationId, pipelineId).catch((error: unknown) => {
    if (!(error instanceof NotFoundError)) throw error;
    throw new ValidationError('Unknown pipeline', [
      { path: 'pipelineId', message: 'Pipeline not found' },
    ]);
  });
  if (stageId === undefined) {
    const stages = await stagesOf(tx, pipelineId);
    const first = stages.find((stage) => stage.kind === 'open');
    if (!first)
      throw new ValidationError('Pipeline has no open stage', [
        { path: 'stageId', message: 'No open stage' },
      ]);
    return first;
  }
  return findStage(tx, organizationId, pipelineId, stageId).catch((error: unknown) => {
    if (!(error instanceof NotFoundError)) throw error;
    throw new ValidationError('Unknown stage', [
      { path: 'stageId', message: 'Stage not found in this pipeline' },
    ]);
  });
}
