import { describe, expect, it } from 'vitest';
import type { Definition } from '@/lib/automation-types';
import { flatten, mapTree, nextKey, toDefinition, toTree } from './tree';

const definition: Definition = {
  trigger: { type: 'contact.created', config: {} },
  nodes: [
    { key: 'tag', type: 'action', action: 'contact.add_tag', label: null, config: { tagId: 't' } },
    {
      key: 'check',
      type: 'condition',
      action: null,
      label: 'VIP?',
      config: { match: 'all', rules: [] },
    },
    { key: 'call', type: 'action', action: 'task.create', label: null, config: { title: 'Call' } },
    { key: 'wait', type: 'wait', action: null, label: null, config: { amount: 1, unit: 'days' } },
    { key: 'mail', type: 'action', action: 'message.email', label: null, config: {} },
  ],
  edges: [
    { from: 'tag', to: 'check', branch: 'next' },
    { from: 'check', to: 'call', branch: 'true' },
    { from: 'call', to: 'wait', branch: 'next' },
    { from: 'check', to: 'mail', branch: 'false' },
  ],
  entry: 'tag',
};

describe('workflow tree', () => {
  it('round-trips a definition with branches', () => {
    let n = 0;
    const tree = toTree(definition, () => `u${(n += 1)}`);
    expect(tree.map((step) => step.key)).toEqual(['tag', 'check']);
    expect(tree[1]?.yes.map((step) => step.key)).toEqual(['call', 'wait']);
    expect(tree[1]?.no.map((step) => step.key)).toEqual(['mail']);
    const back = toDefinition(definition.trigger, tree);
    expect(back.entry).toBe('tag');
    expect(new Set(back.edges.map((edge) => JSON.stringify(edge)))).toEqual(
      new Set(definition.edges.map((edge) => JSON.stringify(edge))),
    );
    // Node order (the API's error paths) follows the tree: branch "yes" before "no".
    expect(flatten(tree).map((step) => step.key)).toEqual(['tag', 'check', 'call', 'wait', 'mail']);
  });

  it('edits and removes steps anywhere and picks unused keys', () => {
    let n = 0;
    const tree = toTree(definition, () => `u${(n += 1)}`);
    const call = tree[1]?.yes[0];
    const renamed = mapTree(tree, call?.uid ?? '', (step) => ({ ...step, label: 'Phone them' }));
    expect(renamed[1]?.yes[0]?.label).toBe('Phone them');
    const removed = mapTree(tree, call?.uid ?? '', () => null);
    expect(removed[1]?.yes.map((step) => step.key)).toEqual(['wait']);
    expect(nextKey(tree)).toBe('step-6');
    expect(toDefinition(definition.trigger, []).entry).toBeNull();
  });
});
