'use client';

import { useMessages } from '@/components/i18n-provider';
import { CheckboxField, SelectField, TextAreaField, TextField } from '@/components/ui/field';
import { humanize } from '@/lib/format';
import type { AutomationOptions } from '@/lib/automation-types';
import { LIFECYCLE_STAGES } from '@/lib/forms-types';
import type { Step } from './tree';

const CONDITION_FIELDS = [
  'contact.email',
  'contact.phone',
  'contact.firstName',
  'contact.lastName',
  'contact.jobTitle',
  'contact.lifecycleStage',
  'contact.status',
  'contact.source',
  'contact.tags',
  'deal.status',
  'deal.stageId',
] as const;
const OPERATORS = [
  'equals',
  'not_equals',
  'contains',
  'not_contains',
  'is_empty',
  'is_not_empty',
  'greater_than',
  'less_than',
  'has_tag',
  'not_has_tag',
] as const;
const VALUELESS = new Set(['is_empty', 'is_not_empty']);
const TAG_OPERATORS = new Set(['has_tag', 'not_has_tag']);

interface Rule {
  field: string;
  operator: string;
  value?: string;
}

const str = (value: unknown) => (typeof value === 'string' ? value : '');

/** Settings of one step; `error(key)` returns the API's message for `config.<key>`. */
export function StepConfig({
  step,
  options,
  error,
  onChange,
}: {
  step: Step;
  options: AutomationOptions;
  error: (key: string) => string | undefined;
  onChange: (config: Record<string, unknown>) => void;
}) {
  const m = useMessages();
  const a = m.automation;
  const config = step.config;
  const set = (patch: Record<string, unknown>) => onChange({ ...config, ...patch });
  const text = (key: string, label: string, props: { max?: number; multiline?: boolean } = {}) =>
    props.multiline ? (
      <TextAreaField
        label={label}
        rows={4}
        value={str(config[key])}
        maxLength={props.max}
        onChange={(event) => set({ [key]: event.target.value })}
        error={error(key)}
      />
    ) : (
      <TextField
        label={label}
        value={str(config[key])}
        maxLength={props.max}
        onChange={(event) => set({ [key]: event.target.value })}
        error={error(key)}
      />
    );
  const tagSelect = (key: string) => (
    <SelectField
      label={a.tag}
      value={str(config[key])}
      onChange={(event) => set({ [key]: event.target.value })}
      error={error(key)}
    >
      <option value="">{a.choose}</option>
      {options.tags.map((tag) => (
        <option key={tag.id} value={tag.id}>
          {tag.name}
        </option>
      ))}
    </SelectField>
  );
  const memberSelect = (key: string) => (
    <SelectField
      label={a.member}
      value={str(config[key])}
      onChange={(event) => set({ [key]: event.target.value || null })}
      error={error(key)}
    >
      <option value="">{a.choose}</option>
      {options.members.map((member) => (
        <option key={member.userId} value={member.userId}>
          {member.name}
        </option>
      ))}
    </SelectField>
  );
  const pipelineAndStage = (openOnly: boolean, stageOptional: boolean) => {
    const pipeline = options.pipelines.find((entry) => entry.id === config.pipelineId);
    return (
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectField
          label={a.pipeline}
          value={str(config.pipelineId)}
          onChange={(event) => set({ pipelineId: event.target.value, stageId: null })}
          error={error('pipelineId')}
        >
          <option value="">{a.choose}</option>
          {options.pipelines.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.name}
            </option>
          ))}
        </SelectField>
        <SelectField
          label={a.stage}
          value={str(config.stageId)}
          onChange={(event) => set({ stageId: event.target.value || null })}
          error={error('stageId')}
        >
          <option value="">{stageOptional ? a.firstOpenStage : a.choose}</option>
          {pipeline?.stages
            .filter((stage) => !openOnly || stage.kind === 'open')
            .map((stage) => (
              <option key={stage.id} value={stage.id}>
                {stage.name}
              </option>
            ))}
        </SelectField>
      </div>
    );
  };
  const channelSelect = (channel: 'email' | 'sms' | 'whatsapp') => (
    <SelectField
      label={a.channel}
      value={str(config.connectionId)}
      onChange={(event) => set({ connectionId: event.target.value })}
      error={error('connectionId')}
    >
      <option value="">{a.choose}</option>
      {options.channels
        .filter((entry) => entry.channel === channel)
        .map((entry) => (
          <option key={entry.id} value={entry.id}>
            {entry.name}
          </option>
        ))}
    </SelectField>
  );

  if (step.type === 'wait') {
    return (
      <div className="grid grid-cols-2 gap-3">
        <TextField
          label={a.waitFor}
          type="number"
          min={1}
          value={typeof config.amount === 'number' ? config.amount : ''}
          onChange={(event) => set({ amount: Number(event.target.value) })}
          error={error('amount')}
        />
        <SelectField
          label={'\u00a0'}
          aria-label={a.waitFor}
          value={str(config.unit)}
          onChange={(event) => set({ unit: event.target.value })}
        >
          {(['minutes', 'hours', 'days'] as const).map((unit) => (
            <option key={unit} value={unit}>
              {a.units[unit]}
            </option>
          ))}
        </SelectField>
      </div>
    );
  }

  if (step.type === 'condition') {
    const rules = (Array.isArray(config.rules) ? config.rules : []) as Rule[];
    const setRule = (index: number, patch: Partial<Rule>) =>
      set({ rules: rules.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)) });
    const fields = [
      ...CONDITION_FIELDS.map((field) => ({ value: field, label: a.fields[field] })),
      ...options.contactFields.map((field) => ({
        value: `contact.custom.${field.key}`,
        label: a.customField.replace('{label}', field.label),
      })),
    ];
    return (
      <div className="space-y-3">
        <SelectField
          label={a.match}
          value={str(config.match) || 'all'}
          onChange={(event) => set({ match: event.target.value })}
        >
          <option value="all">{a.matchAll}</option>
          <option value="any">{a.matchAny}</option>
        </SelectField>
        {rules.map((rule, index) => (
          <div key={index} className="grid gap-2 sm:grid-cols-3" data-testid="condition-rule">
            <SelectField
              label={a.field}
              value={rule.field}
              onChange={(event) => setRule(index, { field: event.target.value })}
              error={error(`rules.${index}.field`)}
            >
              {fields.map((field) => (
                <option key={field.value} value={field.value}>
                  {field.label}
                </option>
              ))}
            </SelectField>
            <SelectField
              label={a.operator}
              value={rule.operator}
              onChange={(event) => setRule(index, { operator: event.target.value })}
            >
              {OPERATORS.filter(
                (operator) => TAG_OPERATORS.has(operator) === (rule.field === 'contact.tags'),
              ).map((operator) => (
                <option key={operator} value={operator}>
                  {a.operators[operator]}
                </option>
              ))}
            </SelectField>
            {VALUELESS.has(rule.operator) ? null : TAG_OPERATORS.has(rule.operator) ? (
              <SelectField
                label={a.value}
                value={rule.value ?? ''}
                onChange={(event) => setRule(index, { value: event.target.value })}
                error={error(`rules.${index}.value`)}
              >
                <option value="">{a.choose}</option>
                {options.tags.map((tag) => (
                  <option key={tag.id} value={tag.id}>
                    {tag.name}
                  </option>
                ))}
              </SelectField>
            ) : (
              <TextField
                label={a.value}
                value={rule.value ?? ''}
                maxLength={500}
                onChange={(event) => setRule(index, { value: event.target.value })}
                error={error(`rules.${index}.value`)}
              />
            )}
          </div>
        ))}
        {rules.length < 10 ? (
          <button
            type="button"
            className="text-sm font-medium text-brand-600 hover:underline"
            onClick={() =>
              set({ rules: [...rules, { field: 'contact.email', operator: 'is_not_empty' }] })
            }
          >
            {a.addRule}
          </button>
        ) : null}
      </div>
    );
  }

  switch (step.action) {
    case 'contact.create':
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          {text('firstName', a.firstName, { max: 200 })}
          {text('lastName', a.lastName, { max: 200 })}
          {text('email', a.email, { max: 320 })}
          {text('phone', a.phone, { max: 60 })}
        </div>
      );
    case 'contact.update':
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          {text('jobTitle', a.jobTitle, { max: 150 })}
          <SelectField
            label={a.lifecycleStage}
            value={str(config.lifecycleStage)}
            onChange={(event) =>
              onChange(
                Object.fromEntries(
                  Object.entries({ ...config, lifecycleStage: event.target.value }).filter(
                    ([, value]) => value !== '',
                  ),
                ),
              )
            }
            error={error('lifecycleStage')}
          >
            <option value="">{a.unchanged}</option>
            {LIFECYCLE_STAGES.map((stage) => (
              <option key={stage} value={stage}>
                {humanize(stage)}
              </option>
            ))}
          </SelectField>
        </div>
      );
    case 'contact.add_tag':
    case 'contact.remove_tag':
      return tagSelect('tagId');
    case 'contact.assign_owner':
      return memberSelect('userId');
    case 'deal.create':
      return (
        <div className="space-y-3">
          {pipelineAndStage(true, true)}
          {text('name', a.dealName, { max: 200 })}
        </div>
      );
    case 'deal.move':
      return pipelineAndStage(false, false);
    case 'task.create':
      return (
        <div className="space-y-3">
          {text('title', a.taskTitle, { max: 300 })}
          {text('description', a.taskDescription, { max: 5_000, multiline: true })}
          <div className="grid gap-3 sm:grid-cols-3">
            <TextField
              label={a.dueInDays}
              type="number"
              min={0}
              max={365}
              value={typeof config.dueInDays === 'number' ? config.dueInDays : ''}
              onChange={(event) =>
                set({ dueInDays: event.target.value === '' ? null : Number(event.target.value) })
              }
              error={error('dueInDays')}
            />
            <SelectField
              label={a.assignee}
              value={str(config.assignee) || 'contact_owner'}
              onChange={(event) => set({ assignee: event.target.value })}
            >
              {(['contact_owner', 'deal_owner', 'user', 'none'] as const).map((value) => (
                <option key={value} value={value}>
                  {a.assignees[value]}
                </option>
              ))}
            </SelectField>
            {config.assignee === 'user' ? memberSelect('userId') : null}
          </div>
        </div>
      );
    case 'message.email':
      return (
        <div className="space-y-3">
          {channelSelect('email')}
          {text('subject', a.subject, { max: 300 })}
          {text('body', a.message, { max: 10_000, multiline: true })}
        </div>
      );
    case 'message.sms':
      return (
        <div className="space-y-3">
          {channelSelect('sms')}
          {text('body', a.message, { max: 1_600, multiline: true })}
        </div>
      );
    case 'message.whatsapp': {
      const templates = options.whatsappTemplates.filter(
        (template) => template.connectionId === config.connectionId,
      );
      const parameters = Array.isArray(config.parameters) ? (config.parameters as string[]) : [];
      return (
        <div className="space-y-3">
          {channelSelect('whatsapp')}
          <SelectField
            label={a.template}
            value={`${str(config.templateName)}|${str(config.language)}`}
            onChange={(event) => {
              const [templateName = '', language = ''] = event.target.value.split('|');
              set({ templateName, language });
            }}
            error={error('templateName')}
          >
            <option value="|">{a.choose}</option>
            {templates.map((template) => (
              <option
                key={`${template.name}|${template.language}`}
                value={`${template.name}|${template.language}`}
              >
                {template.name} ({template.language})
              </option>
            ))}
          </SelectField>
          <TextAreaField
            label={a.templateParameters}
            rows={3}
            value={parameters.join('\n')}
            onChange={(event) => set({ parameters: event.target.value.split('\n') })}
            error={error('parameters')}
          />
        </div>
      );
    }
    case 'http.request':
      return (
        <div className="space-y-3">
          {text('url', a.url, { max: 2_000 })}
          <CheckboxField
            label={a.includeContact}
            checked={config.includeContact !== false}
            onChange={(event) => set({ includeContact: event.target.checked })}
          />
          <p className="text-xs text-slate-500">{a.webhookHint}</p>
        </div>
      );
    default:
      return null;
  }
}
