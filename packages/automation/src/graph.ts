import type { EdgeBranch, NodeType } from '@businessos/database';
import { z } from 'zod';
import { ACTION_TYPES, ACTIONS } from './actions';
import { conditionConfigSchema } from './conditions';
import { triggerInputSchema } from './triggers';

export const MAX_NODES = 50;
export const MAX_WAIT_MINUTES = 30 * 24 * 60;

const UNIT_MINUTES = { minutes: 1, hours: 60, days: 24 * 60 } as const;

export const waitConfigSchema = z
  .object({
    amount: z.number().int().min(1).max(43_200),
    unit: z.enum(['minutes', 'hours', 'days']),
  })
  .refine((config) => config.amount * UNIT_MINUTES[config.unit] <= MAX_WAIT_MINUTES, {
    message: 'Waits can last at most 30 days',
    path: ['amount'],
  });
export type WaitConfig = z.infer<typeof waitConfigSchema>;

export function waitMilliseconds(config: WaitConfig): number {
  return config.amount * UNIT_MINUTES[config.unit] * 60_000;
}

const keySchema = z.string().regex(/^[a-z0-9_-]{1,40}$/, 'Lower-case letters, digits, - and _');
const labelSchema = z.string().trim().max(120).nullable().default(null);

const nodeSchema = z.discriminatedUnion('type', [
  z.object({
    key: keySchema,
    type: z.literal('action'),
    action: z.enum(ACTION_TYPES),
    label: labelSchema,
    config: z.record(z.string(), z.unknown()).default({}),
  }),
  z.object({
    key: keySchema,
    type: z.literal('condition'),
    action: z.null().default(null),
    label: labelSchema,
    config: conditionConfigSchema,
  }),
  z.object({
    key: keySchema,
    type: z.literal('wait'),
    action: z.null().default(null),
    label: labelSchema,
    config: waitConfigSchema,
  }),
]);

const edgeSchema = z.object({
  from: keySchema,
  to: keySchema,
  branch: z.enum(['next', 'true', 'false']),
});

const BRANCHES: Record<NodeType, readonly EdgeBranch[]> = {
  action: ['next'],
  wait: ['next'],
  condition: ['true', 'false'],
};

/**
 * A workflow version: its trigger and a tree of steps. Every step has exactly one way in (no
 * merges and no cycles), so a run visits each step at most once — which is what makes steps
 * idempotent per run and loops impossible inside a workflow.
 */
export const definitionSchema = z
  .object({
    trigger: triggerInputSchema,
    nodes: z.array(nodeSchema).max(MAX_NODES),
    edges: z.array(edgeSchema).max(MAX_NODES * 2),
    entry: keySchema.nullable(),
  })
  .superRefine((definition, ctx) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: 'custom', path, message });
    const nodes = new Map<string, (typeof definition.nodes)[number]>();
    definition.nodes.forEach((node, index) => {
      if (nodes.has(node.key)) issue(['nodes', index, 'key'], 'Step keys must be unique');
      nodes.set(node.key, node);
      if (node.type === 'action') {
        const parsed = ACTIONS[node.action].schema.safeParse(node.config);
        if (!parsed.success) {
          for (const problem of parsed.error.issues) {
            issue(['nodes', index, 'config', ...problem.path.map(String)], problem.message);
          }
        }
      }
    });
    if (definition.nodes.length === 0) {
      if (definition.entry !== null) issue(['entry'], 'There are no steps');
      if (definition.edges.length > 0) issue(['edges'], 'There are no steps');
      return;
    }
    if (definition.entry === null || !nodes.has(definition.entry)) {
      issue(['entry'], 'Choose the first step');
      return;
    }
    const outgoing = new Map<string, string[]>();
    const incoming = new Set<string>();
    definition.edges.forEach((edge, index) => {
      const from = nodes.get(edge.from);
      if (!from || !nodes.has(edge.to)) {
        issue(['edges', index], 'Connects a step that does not exist');
        return;
      }
      if (edge.from === edge.to) issue(['edges', index], 'A step cannot lead to itself');
      if (!BRANCHES[from.type].includes(edge.branch)) {
        issue(
          ['edges', index, 'branch'],
          `A ${from.type} step cannot have a "${edge.branch}" path`,
        );
      }
      const branches = outgoing.get(edge.from) ?? [];
      if (branches.includes(edge.branch)) issue(['edges', index], 'Duplicate path');
      outgoing.set(edge.from, [...branches, edge.branch]);
      if (incoming.has(edge.to)) issue(['edges', index], 'A step can only be reached one way');
      incoming.add(edge.to);
    });
    if (incoming.has(definition.entry)) issue(['entry'], 'The first step cannot be reached again');
    // Every step must be reachable from the first one (this also rules out cycles).
    const seen = new Set<string>();
    const queue = [definition.entry];
    while (queue.length > 0) {
      const key = queue.shift() ?? '';
      if (seen.has(key)) continue;
      seen.add(key);
      for (const edge of definition.edges) if (edge.from === key) queue.push(edge.to);
    }
    definition.nodes.forEach((node, index) => {
      if (!seen.has(node.key)) issue(['nodes', index], 'This step can never be reached');
    });
  })
  // Store action settings with their defaults filled in (they were validated above).
  .transform((definition) => ({
    ...definition,
    nodes: definition.nodes.map((node) =>
      node.type === 'action'
        ? {
            ...node,
            config: ACTIONS[node.action].schema.parse(node.config) as Record<string, unknown>,
          }
        : node,
    ),
  }));
export type WorkflowDefinition = z.infer<typeof definitionSchema>;
export type DefinitionInput = z.input<typeof definitionSchema>;
export type DefinitionNode = WorkflowDefinition['nodes'][number];
