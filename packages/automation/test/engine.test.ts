import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import {
  checkWebhookUrl,
  definitionSchema,
  evaluateCondition,
  HttpRequestError,
  isPublicAddress,
  matchesTrigger,
  postJson,
  renderTemplate,
  resolvePath,
  type DefinitionInput,
  type RunContext,
} from '../src';

const context: RunContext = {
  organization: { name: 'Seef Interiors', timezone: 'Asia/Bahrain' },
  contact: {
    id: '0190a6d6-5f5e-7cc1-9f0e-2a3b4c5d6e7f',
    firstName: 'Layla',
    lastName: 'Hasan',
    fullName: 'Layla Hasan',
    email: 'layla@example.com',
    phone: '+97333123456',
    whatsappPhone: null,
    jobTitle: null,
    lifecycleStage: 'lead',
    status: 'active',
    source: 'form',
    ownerUserId: null,
    tags: ['0190a6d6-5f5e-7cc1-9f0e-000000000001'],
    tagNames: ['VIP'],
    custom: { budget: '12.500', size: 'large' },
  },
  deal: null,
  trigger: { formId: 'f1', body: { email: 'new@example.com', nested: { level: 3 } } },
};

describe('templates', () => {
  it('fills known placeholders and leaves nothing executable', () => {
    expect(
      renderTemplate(
        'Hi {{contact.firstName}} ({{ contact.custom.size }}) from {{organization.name}} {{trigger.body.nested.level}}',
        context,
      ),
    ).toBe('Hi Layla (large) from Seef Interiors 3');
    expect(renderTemplate('{{deal.name}}|{{contact.missing}}|{{constructor}}', context)).toBe('||');
    expect(renderTemplate('{{contact.tagNames}}', context)).toBe('VIP');
    expect(resolvePath(context, 'contact.__proto__')).toBeNull();
    expect(resolvePath(context, 'trigger.body')).toEqual({
      email: 'new@example.com',
      nested: { level: 3 },
    });
    expect(renderTemplate('{{trigger.body}}', context)).toBe('');
    expect(renderTemplate('x'.repeat(50), context, 10)).toHaveLength(10);
  });
});

describe('conditions', () => {
  const rule = (field: string, operator: string, value?: string) =>
    evaluateCondition({ match: 'all', rules: [{ field, operator, value } as never] }, context);

  it('compares case-insensitively, numerically and by tag', () => {
    expect(rule('contact.email', 'equals', 'LAYLA@example.com')).toBe(true);
    expect(rule('contact.email', 'contains', 'example')).toBe(true);
    expect(rule('contact.jobTitle', 'is_empty')).toBe(true);
    expect(rule('contact.custom.budget', 'greater_than', '10')).toBe(true);
    expect(rule('contact.custom.budget', 'less_than', '10')).toBe(false);
    expect(rule('contact.tags', 'has_tag', '0190a6d6-5f5e-7cc1-9f0e-000000000001')).toBe(true);
    expect(rule('contact.tags', 'not_has_tag', '0190a6d6-5f5e-7cc1-9f0e-000000000001')).toBe(false);
    expect(rule('contact.tagNames', 'equals', 'vip')).toBe(true);
    expect(rule('deal.name', 'is_empty')).toBe(true);
    expect(
      evaluateCondition(
        {
          match: 'any',
          rules: [
            { field: 'contact.email', operator: 'equals', value: 'other@example.com' },
            { field: 'contact.lifecycleStage', operator: 'equals', value: 'lead' },
          ],
        },
        context,
      ),
    ).toBe(true);
  });
});

const tagId = '0190a6d6-5f5e-7cc1-9f0e-000000000001';

function definition(overrides: Partial<DefinitionInput> = {}): DefinitionInput {
  return {
    trigger: { type: 'contact.created', config: {} },
    nodes: [
      { key: 'tag', type: 'action', action: 'contact.add_tag', config: { tagId } },
      { key: 'wait', type: 'wait', config: { amount: 2, unit: 'days' } },
      {
        key: 'vip',
        type: 'condition',
        config: { rules: [{ field: 'contact.tags', operator: 'has_tag', value: tagId }] },
      },
      {
        key: 'task',
        type: 'action',
        action: 'task.create',
        config: { title: 'Call {{contact.firstName}}' },
      },
    ],
    edges: [
      { from: 'tag', to: 'wait', branch: 'next' },
      { from: 'wait', to: 'vip', branch: 'next' },
      { from: 'vip', to: 'task', branch: 'true' },
    ],
    entry: 'tag',
    ...overrides,
  };
}

function problems(input: DefinitionInput): string[] {
  const result = definitionSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'));
}

describe('workflow definitions', () => {
  it('accepts a tree of steps', () => {
    expect(problems(definition())).toEqual([]);
    expect(definitionSchema.parse(definition()).nodes[3]?.config).toMatchObject({
      assignee: 'contact_owner',
      priority: 'normal',
    });
  });

  it('refuses cycles, merges, unreachable steps and impossible branches', () => {
    const base = definition();
    // Cycle back to the first step.
    expect(
      problems({ ...base, edges: [...base.edges, { from: 'task', to: 'tag', branch: 'next' }] }),
    ).toContain('entry');
    // Two ways into one step (a merge) and a "true" path from an action.
    expect(
      problems({
        ...base,
        edges: [
          { from: 'tag', to: 'wait', branch: 'next' },
          { from: 'wait', to: 'vip', branch: 'next' },
          { from: 'vip', to: 'task', branch: 'true' },
          { from: 'tag', to: 'task', branch: 'true' },
        ],
      }),
    ).toEqual(expect.arrayContaining(['edges.3.branch', 'edges.3']));
    // A step that can never run.
    expect(problems({ ...base, edges: base.edges.slice(0, 2) })).toContain('nodes.3');
    // Self loop, unknown step, duplicate keys.
    expect(
      problems({ ...base, edges: [...base.edges, { from: 'task', to: 'task', branch: 'next' }] })
        .length,
    ).toBeGreaterThan(0);
    expect(problems({ ...base, entry: 'nope' })).toContain('entry');
    expect(
      problems({
        ...base,
        nodes: [
          ...base.nodes,
          { key: 'tag', type: 'wait', config: { amount: 1, unit: 'minutes' } },
        ],
      }),
    ).toEqual(expect.arrayContaining(['nodes.4.key']));
  });

  it('validates step settings, placeholders and wait limits', () => {
    expect(
      problems(
        definition({
          nodes: [
            { key: 'tag', type: 'action', action: 'contact.add_tag', config: { tagId: 'x' } },
          ],
          edges: [],
        }),
      ),
    ).toEqual(['nodes.0.config.tagId']);
    expect(
      problems(
        definition({
          nodes: [
            {
              key: 'task',
              type: 'action',
              action: 'task.create',
              config: { title: 'Hi {{password}}' },
            },
          ],
          edges: [],
          entry: 'task',
        }),
      ),
    ).toEqual(['nodes.0.config.title']);
    expect(
      problems(
        definition({
          nodes: [{ key: 'wait', type: 'wait', config: { amount: 31, unit: 'days' } }],
          edges: [],
          entry: 'wait',
        }),
      ),
    ).toEqual(['nodes.0.config.amount']);
    expect(
      problems(
        definition({
          nodes: [
            {
              key: 'deal',
              type: 'action',
              action: 'deal.create',
              config: {
                pipelineId: tagId,
                name: 'Deal',
                value: { amount: '12.5005', currency: 'BHD' },
              },
            },
          ],
          edges: [],
          entry: 'deal',
        }),
      ),
    ).toEqual(['nodes.0.config.value.amount']);
    expect(problems(definition({ trigger: { type: 'contact.tag_added', config: {} } }))).toEqual([
      'trigger.config.tagId',
    ]);
    expect(() => definitionSchema.parse({ ...definition(), nodes: 'x' })).toThrow(ZodError);
  });
});

describe('trigger filters', () => {
  const event = (type: string, payload: Record<string, unknown>) => ({ type, payload }) as never;

  it('filters by form, pipeline/stage, tag, channel and changed fields', () => {
    expect(
      matchesTrigger('form.submitted', { formId: null }, event('form.submitted', { formId: 'a' })),
    ).toBe(true);
    expect(
      matchesTrigger('form.submitted', { formId: tagId }, event('form.submitted', { formId: 'a' })),
    ).toBe(false);
    expect(
      matchesTrigger(
        'deal.stage_changed',
        { pipelineId: null, toStageId: tagId },
        event('deal.stage_changed', { pipelineId: 'p', toStageId: tagId }),
      ),
    ).toBe(true);
    expect(
      matchesTrigger(
        'contact.tag_added',
        { tagId },
        event('contact.tag_added', { tagId: 'other' }),
      ),
    ).toBe(false);
    expect(
      matchesTrigger(
        'contact.updated',
        { fields: ['email'] },
        event('contact.updated', { changedFields: ['jobTitle'] }),
      ),
    ).toBe(false);
    expect(
      matchesTrigger(
        'message.received',
        { channel: 'whatsapp' },
        event('message.received', { channel: 'whatsapp' }),
      ),
    ).toBe(true);
    // A stored config that no longer validates never matches.
    expect(matchesTrigger('contact.tag_added', {}, event('contact.tag_added', { tagId }))).toBe(
      false,
    );
  });
});

describe('webhook action network guard (SSRF)', () => {
  let server: Server;
  let port = 0;
  beforeAll(async () => {
    server = createServer((_, response) => response.writeHead(204).end());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('classifies addresses', () => {
    for (const address of [
      '127.0.0.1',
      '10.1.2.3',
      '172.20.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      'fd00::1',
      'fe80::1',
      '::ffff:127.0.0.1',
      '::ffff:10.0.0.1',
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
    for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) {
      expect(isPublicAddress(address), address).toBe(true);
    }
  });

  it('refuses unsafe destinations before connecting', () => {
    for (const url of [
      'http://example.com/hook',
      'https://user:pass@example.com/hook',
      'https://127.0.0.1/hook',
      'https://[::1]/hook',
      'https://169.254.169.254/latest/meta-data',
      'https://localhost/hook',
      'ftp://example.com',
      'not a url',
    ]) {
      expect(() => checkWebhookUrl(url), url).toThrow(HttpRequestError);
    }
    expect(checkWebhookUrl('https://hooks.example.com/x').hostname).toBe('hooks.example.com');
    // Calling BusinessOS itself (e.g. a workflow's own inbound webhook) could loop forever.
    expect(() =>
      checkWebhookUrl('https://API.BusinessOS.example/webhooks/automation/x', false, [
        'api.businessos.example',
      ]),
    ).toThrow('Workflows cannot call BusinessOS itself');
  });

  it('refuses names that resolve to private addresses at connect time', async () => {
    // A public-looking name whose DNS answer is private (e.g. DNS rebinding).
    const rebinding = (
      _: string,
      callback: (error: null, addresses: { address: string; family: number }[]) => void,
    ) =>
      callback(null, [
        { address: '93.184.216.34', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ]);
    const error = await postJson(
      `https://hooks.example.com:${port}/hook`,
      {},
      { resolver: rebinding },
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HttpRequestError);
    expect((error as HttpRequestError).retryable).toBe(false);
    // Allowed only when explicitly enabled for development and tests.
    await expect(
      postJson(`http://127.0.0.1:${port}/hook`, {}, { allowPrivateNetwork: true }),
    ).resolves.toEqual({
      status: 204,
    });
  });
});
