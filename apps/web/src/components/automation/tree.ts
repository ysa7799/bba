import type { ActionType, Definition, DefinitionNode, NodeType } from '@/lib/automation-types';

/**
 * The builder edits workflows as a tree: a list of steps where a condition ends its list and
 * opens a "yes" and a "no" list. That is exactly the shape the API accepts (every step has one
 * way in), stored as nodes and edges.
 */
export interface Step {
  /** Stable React key. */
  uid: string;
  key: string;
  type: NodeType;
  action: ActionType | null;
  label: string | null;
  config: Record<string, unknown>;
  yes: Step[];
  no: Step[];
}

export function toTree(definition: Definition, makeUid: () => string): Step[] {
  const nodes = new Map(definition.nodes.map((node) => [node.key, node]));
  const next = (from: string, branch: string) =>
    definition.edges.find((edge) => edge.from === from && edge.branch === branch)?.to ?? null;
  const build = (start: string | null, seen: Set<string>): Step[] => {
    const list: Step[] = [];
    let key = start;
    while (key && !seen.has(key)) {
      seen.add(key);
      const node = nodes.get(key);
      if (!node) break;
      const step: Step = {
        uid: makeUid(),
        key: node.key,
        type: node.type,
        action: node.action,
        label: node.label,
        config: node.config,
        yes: [],
        no: [],
      };
      list.push(step);
      if (node.type === 'condition') {
        step.yes = build(next(key, 'true'), seen);
        step.no = build(next(key, 'false'), seen);
        break;
      }
      key = next(key, 'next');
    }
    return list;
  };
  return build(definition.entry, new Set());
}

/** Steps in the order the API receives them (error paths `nodes.<index>` refer to it). */
export function flatten(steps: readonly Step[]): Step[] {
  return steps.flatMap((step) => [step, ...flatten(step.yes), ...flatten(step.no)]);
}

export function toDefinition(trigger: Definition['trigger'], steps: readonly Step[]): Definition {
  const edges: Definition['edges'] = [];
  const link = (list: readonly Step[]) => {
    list.forEach((step, index) => {
      const following = list[index + 1];
      if (step.type === 'condition') {
        if (step.yes[0]) edges.push({ from: step.key, to: step.yes[0].key, branch: 'true' });
        if (step.no[0]) edges.push({ from: step.key, to: step.no[0].key, branch: 'false' });
        link(step.yes);
        link(step.no);
      } else if (following) {
        edges.push({ from: step.key, to: following.key, branch: 'next' });
      }
    });
  };
  link(steps);
  const nodes: DefinitionNode[] = flatten(steps).map((step) => ({
    key: step.key,
    type: step.type,
    action: step.type === 'action' ? step.action : null,
    label: step.label?.trim() ? step.label.trim() : null,
    config: step.config,
  }));
  return { trigger, nodes, edges, entry: steps[0]?.key ?? null };
}

export function defaultConfig(type: NodeType, action: ActionType | null): Record<string, unknown> {
  if (type === 'wait') return { amount: 1, unit: 'days' };
  if (type === 'condition') {
    return { match: 'all', rules: [{ field: 'contact.email', operator: 'is_not_empty' }] };
  }
  switch (action) {
    case 'contact.create':
      return { firstName: '', lastName: '', email: '{{trigger.body.email}}', phone: '' };
    case 'contact.update':
      return { lifecycleStage: 'qualified' };
    case 'deal.create':
      return { pipelineId: '', stageId: null, name: '{{contact.fullName}}', value: null };
    case 'task.create':
      return {
        title: 'Follow up with {{contact.fullName}}',
        description: '',
        dueInDays: 1,
        priority: 'normal',
        assignee: 'contact_owner',
        userId: null,
      };
    case 'message.email':
      return { connectionId: '', subject: 'Hello {{contact.firstName}}', body: '' };
    case 'message.sms':
      return { connectionId: '', body: '' };
    case 'message.whatsapp':
      return { connectionId: '', templateName: '', language: 'en', parameters: [] };
    case 'http.request':
      return { url: 'https://', includeContact: true };
    default:
      return {};
  }
}

/** The next unused node key (`step-1`, `step-2`…). */
export function nextKey(steps: readonly Step[]): string {
  const taken = new Set(flatten(steps).map((step) => step.key));
  let n = taken.size + 1;
  while (taken.has(`step-${n}`)) n += 1;
  return `step-${n}`;
}

/** Applies `update` to the step with `uid` anywhere in the tree. */
export function mapTree(
  steps: readonly Step[],
  uid: string,
  update: (step: Step) => Step | null,
): Step[] {
  const out: Step[] = [];
  for (const step of steps) {
    if (step.uid === uid) {
      const updated = update(step);
      if (updated) out.push(updated);
      continue;
    }
    out.push({ ...step, yes: mapTree(step.yes, uid, update), no: mapTree(step.no, uid, update) });
  }
  return out;
}
