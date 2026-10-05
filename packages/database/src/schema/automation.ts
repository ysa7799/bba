import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { primaryId, tenantIsolationPolicy, timestamps } from './_helpers';
import { crmContacts, crmDeals } from './crm';
import { organizations } from './organizations';
import { users } from './users';

const orgId = () =>
  uuid()
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' });

/** `draft`: never published · `active`: runs on triggers · `paused`: nothing starts or continues. */
export const WORKFLOW_STATUSES = ['draft', 'active', 'paused', 'archived'] as const;
export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];

export const automationWorkflows = pgTable(
  'automation_workflows',
  {
    id: primaryId(),
    organizationId: orgId(),
    name: text().notNull(),
    description: text(),
    status: text({ enum: WORKFLOW_STATUSES }).notNull().default('draft'),
    /** SHA-256 of the inbound webhook token (the token is shown once, never stored). */
    webhookTokenHash: text(),
    createdByUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('automation_workflows_id_org_unique').on(t.id, t.organizationId),
    uniqueIndex('automation_workflows_webhook_token_unique').on(t.webhookTokenHash),
    index('automation_workflows_org_idx').on(t.organizationId, t.status),
    check('automation_workflows_name_check', sql`char_length(${t.name}) between 1 and 120`),
    check(
      'automation_workflows_status_check',
      sql`${t.status} in ('draft', 'active', 'paused', 'archived')`,
    ),
    tenantIsolationPolicy(),
  ],
);

export const WORKFLOW_VERSION_STATUSES = ['draft', 'published', 'retired'] as const;

/** Trigger, steps and branches of a workflow. Published and retired versions are immutable. */
export const automationWorkflowVersions = pgTable(
  'automation_workflow_versions',
  {
    id: primaryId(),
    organizationId: orgId(),
    workflowId: uuid().notNull(),
    number: integer().notNull(),
    status: text({ enum: WORKFLOW_VERSION_STATUSES }).notNull().default('draft'),
    triggerType: text().notNull(),
    /** Trigger filters (validated by the automation service). */
    triggerConfig: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    /** First node (null: a workflow without steps). */
    entryNodeKey: text(),
    publishedAt: timestamp({ withTimezone: true }),
    publishedByUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('automation_versions_id_org_unique').on(t.id, t.organizationId),
    uniqueIndex('automation_versions_number_unique').on(t.workflowId, t.number),
    uniqueIndex('automation_versions_one_draft')
      .on(t.workflowId)
      .where(sql`${t.status} = 'draft'`),
    uniqueIndex('automation_versions_one_published')
      .on(t.workflowId)
      .where(sql`${t.status} = 'published'`),
    index('automation_versions_trigger_idx').on(t.organizationId, t.triggerType, t.status),
    foreignKey({
      name: 'automation_versions_workflow_fk',
      columns: [t.workflowId, t.organizationId],
      foreignColumns: [automationWorkflows.id, automationWorkflows.organizationId],
    }).onDelete('cascade'),
    check(
      'automation_versions_status_check',
      sql`${t.status} in ('draft', 'published', 'retired')`,
    ),
    tenantIsolationPolicy(),
  ],
);

export const NODE_TYPES = ['action', 'condition', 'wait'] as const;
export type NodeType = (typeof NODE_TYPES)[number];

/** One step of a version. */
export const automationNodes = pgTable(
  'automation_nodes',
  {
    id: primaryId(),
    organizationId: orgId(),
    versionId: uuid().notNull(),
    key: text().notNull(),
    type: text({ enum: NODE_TYPES }).notNull(),
    /** Action type for `action` nodes (`contact.add_tag`, `message.email`…). */
    action: text(),
    label: text(),
    config: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    position: integer().notNull(),
  },
  (t) => [
    uniqueIndex('automation_nodes_version_key_unique').on(t.versionId, t.key),
    foreignKey({
      name: 'automation_nodes_version_fk',
      columns: [t.versionId, t.organizationId],
      foreignColumns: [automationWorkflowVersions.id, automationWorkflowVersions.organizationId],
    }).onDelete('cascade'),
    check('automation_nodes_key_check', sql`${t.key} ~ '^[a-z0-9_-]{1,40}$'`),
    check('automation_nodes_type_check', sql`${t.type} in ('action', 'condition', 'wait')`),
    tenantIsolationPolicy(),
  ],
);

export const EDGE_BRANCHES = ['next', 'true', 'false'] as const;
export type EdgeBranch = (typeof EDGE_BRANCHES)[number];

/** Connection between two nodes; conditions have a `true` and a `false` branch. */
export const automationEdges = pgTable(
  'automation_edges',
  {
    id: primaryId(),
    organizationId: orgId(),
    versionId: uuid().notNull(),
    fromKey: text().notNull(),
    toKey: text().notNull(),
    branch: text({ enum: EDGE_BRANCHES }).notNull(),
  },
  (t) => [
    uniqueIndex('automation_edges_from_unique').on(t.versionId, t.fromKey, t.branch),
    uniqueIndex('automation_edges_to_unique').on(t.versionId, t.toKey),
    foreignKey({
      name: 'automation_edges_version_fk',
      columns: [t.versionId, t.organizationId],
      foreignColumns: [automationWorkflowVersions.id, automationWorkflowVersions.organizationId],
    }).onDelete('cascade'),
    check('automation_edges_branch_check', sql`${t.branch} in ('next', 'true', 'false')`),
    check('automation_edges_no_self_loop', sql`${t.fromKey} <> ${t.toKey}`),
    tenantIsolationPolicy(),
  ],
);

export const RUN_STATUSES = [
  'running',
  'waiting',
  'completed',
  'failed',
  'cancelled',
  'skipped',
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** One execution of a published version for one trigger occurrence. */
export const automationRuns = pgTable(
  'automation_runs',
  {
    id: primaryId(),
    organizationId: orgId(),
    workflowId: uuid().notNull(),
    versionId: uuid().notNull(),
    status: text({ enum: RUN_STATUSES }).notNull(),
    triggerType: text().notNull(),
    /** Trigger occurrence (event id, or webhook delivery key): a run starts once per occurrence. */
    dedupeKey: text().notNull(),
    sourceEventId: uuid(),
    contactId: uuid(),
    dealId: uuid(),
    /** Trigger payload snapshot (event payload or webhook body, size-capped). */
    triggerData: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    /** Automation chain depth (loop protection): runs caused by another run's actions. */
    depth: integer().notNull().default(0),
    parentRunId: uuid(),
    currentNodeKey: text(),
    /** When a waiting run (wait step or retry backoff) is due. */
    resumeAt: timestamp({ withTimezone: true }),
    /** The run fails if it has not finished by then. */
    deadlineAt: timestamp({ withTimezone: true }).notNull(),
    error: text(),
    startedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    uniqueIndex('automation_runs_id_org_unique').on(t.id, t.organizationId),
    uniqueIndex('automation_runs_dedupe_unique').on(t.workflowId, t.dedupeKey),
    index('automation_runs_workflow_idx').on(t.workflowId, t.startedAt.desc(), t.id.desc()),
    index('automation_runs_due_idx')
      .on(t.resumeAt)
      .where(sql`${t.status} in ('running', 'waiting')`),
    index('automation_runs_contact_idx').on(t.workflowId, t.contactId, t.startedAt),
    foreignKey({
      name: 'automation_runs_workflow_fk',
      columns: [t.workflowId, t.organizationId],
      foreignColumns: [automationWorkflows.id, automationWorkflows.organizationId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'automation_runs_version_fk',
      columns: [t.versionId, t.organizationId],
      foreignColumns: [automationWorkflowVersions.id, automationWorkflowVersions.organizationId],
    }),
    foreignKey({
      name: 'automation_runs_contact_fk',
      columns: [t.contactId, t.organizationId],
      foreignColumns: [crmContacts.id, crmContacts.organizationId],
    }),
    foreignKey({
      name: 'automation_runs_deal_fk',
      columns: [t.dealId, t.organizationId],
      foreignColumns: [crmDeals.id, crmDeals.organizationId],
    }),
    check(
      'automation_runs_status_check',
      sql`${t.status} in ('running', 'waiting', 'completed', 'failed', 'cancelled', 'skipped')`,
    ),
    check('automation_runs_depth_check', sql`${t.depth} >= 0`),
    tenantIsolationPolicy(),
  ],
);

export const STEP_STATUSES = ['running', 'waiting', 'succeeded', 'failed', 'cancelled'] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

/**
 * Execution of one node in one run. Unique per (run, node): a step that succeeded is never
 * executed again, which makes retries and duplicate jobs idempotent.
 */
export const automationRunSteps = pgTable(
  'automation_run_steps',
  {
    id: primaryId(),
    organizationId: orgId(),
    runId: uuid().notNull(),
    nodeKey: text().notNull(),
    nodeType: text({ enum: NODE_TYPES }).notNull(),
    action: text(),
    status: text({ enum: STEP_STATUSES }).notNull(),
    attempts: integer().notNull().default(0),
    resumeAt: timestamp({ withTimezone: true }),
    output: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    error: text(),
    startedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    uniqueIndex('automation_steps_run_node_unique').on(t.runId, t.nodeKey),
    foreignKey({
      name: 'automation_steps_run_fk',
      columns: [t.runId, t.organizationId],
      foreignColumns: [automationRuns.id, automationRuns.organizationId],
    }).onDelete('cascade'),
    check(
      'automation_steps_status_check',
      sql`${t.status} in ('running', 'waiting', 'succeeded', 'failed', 'cancelled')`,
    ),
    tenantIsolationPolicy(),
  ],
);

export const RUN_LOG_LEVELS = ['info', 'warn', 'error'] as const;

/** Human-readable run history (what happened, why something was skipped or failed). */
export const automationRunLogs = pgTable(
  'automation_run_logs',
  {
    id: primaryId(),
    organizationId: orgId(),
    runId: uuid().notNull(),
    nodeKey: text(),
    level: text({ enum: RUN_LOG_LEVELS }).notNull(),
    message: text().notNull(),
    at: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('automation_run_logs_run_idx').on(t.runId, t.at),
    foreignKey({
      name: 'automation_run_logs_run_fk',
      columns: [t.runId, t.organizationId],
      foreignColumns: [automationRuns.id, automationRuns.organizationId],
    }).onDelete('cascade'),
    check('automation_run_logs_level_check', sql`${t.level} in ('info', 'warn', 'error')`),
    tenantIsolationPolicy(),
  ],
);

export type AutomationWorkflow = typeof automationWorkflows.$inferSelect;
export type AutomationWorkflowVersion = typeof automationWorkflowVersions.$inferSelect;
export type AutomationNode = typeof automationNodes.$inferSelect;
export type AutomationEdge = typeof automationEdges.$inferSelect;
export type AutomationRun = typeof automationRuns.$inferSelect;
export type AutomationRunStep = typeof automationRunSteps.$inferSelect;
export type AutomationRunLog = typeof automationRunLogs.$inferSelect;
