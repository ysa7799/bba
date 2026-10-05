'use client';

import { useState, type SubmitEvent } from 'react';
import { useCan, useOrg } from '@/components/app/org-access';
import { useMutation } from '@/components/app/use-mutation';
import { useMessages } from '@/components/i18n-provider';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { CheckboxField, SelectField, TextAreaField, TextField } from '@/components/ui/field';
import { apiRequest } from '@/lib/api-client';
import {
  CUSTOM_FIELD_TYPES,
  type CustomFieldDefinition,
  type CustomFieldType,
} from '@/lib/crm-types';
import { humanize } from '@/lib/format';

const ENTITIES = ['contact', 'company', 'deal'] as const;

function optionsFromText(text: string) {
  return [
    ...new Set(
      text
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ].map((label) => ({ value: label, label }));
}

export function CustomFieldSettings({ fields }: { fields: CustomFieldDefinition[] }) {
  const m = useMessages();
  const { organizationId } = useOrg();
  const canManage = useCan('crm.custom_field.manage');
  const { run, pending, error } = useMutation();
  const [form, setForm] = useState({
    entityType: 'contact' as (typeof ENTITIES)[number],
    key: '',
    label: '',
    type: 'text' as CustomFieldType,
    options: '',
    required: false,
    helpText: '',
  });
  const base = `/app/orgs/${organizationId}/crm/custom-fields`;
  const isSelect = form.type === 'select' || form.type === 'multi_select';

  async function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const ok = await run(() =>
      apiRequest(base, {
        body: {
          entityType: form.entityType,
          key: form.key,
          label: form.label,
          type: form.type,
          options: isSelect ? optionsFromText(form.options) : [],
          required: form.required,
          helpText: form.helpText || null,
        },
      }),
    );
    if (ok)
      setForm((current) => ({
        ...current,
        key: '',
        label: '',
        options: '',
        helpText: '',
        required: false,
      }));
  }

  return (
    <Card className="space-y-4 p-4">
      <h2 className="text-sm font-semibold text-slate-900">{m.crm.settings.customFields}</h2>
      {error && error.code !== 'validation_error' ? (
        <Alert tone="error">{error.message}</Alert>
      ) : null}
      {ENTITIES.map((entity) => {
        const list = fields.filter((field) => field.entityType === entity);
        return (
          <div key={entity}>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              {m.crm.settings.entities[entity]}
            </h3>
            {list.length === 0 ? (
              <p className="py-1 text-sm text-slate-500">—</p>
            ) : (
              <ul className="divide-y divide-slate-100 text-sm">
                {list.map((field) => (
                  <li
                    key={field.id}
                    className="flex flex-wrap items-center justify-between gap-2 py-2"
                  >
                    <span className={field.archived ? 'text-slate-400' : 'text-slate-800'}>
                      <span className="font-medium">{field.label}</span>{' '}
                      <code className="text-xs text-slate-500">{field.key}</code> ·{' '}
                      {humanize(field.type)}
                      {field.required ? ` · ${m.crm.settings.fieldRequired}` : ''}
                      {field.archived ? ` · ${m.crm.settings.archived}` : ''}
                    </span>
                    {canManage ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          void run(() =>
                            apiRequest(`${base}/${field.id}`, {
                              method: 'PATCH',
                              body: { archived: !field.archived },
                            }),
                          )
                        }
                      >
                        {field.archived ? m.crm.settings.restore : m.crm.settings.archive}
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
      {canManage ? (
        <form
          onSubmit={onSubmit}
          className="space-y-3 rounded-md border border-dashed border-slate-300 p-3"
          noValidate
        >
          <h3 className="text-sm font-medium text-slate-900">{m.crm.settings.newField}</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <SelectField
              label={m.crm.settings.fieldEntity}
              value={form.entityType}
              onChange={(event) =>
                setForm({ ...form, entityType: event.target.value as (typeof ENTITIES)[number] })
              }
            >
              {ENTITIES.map((entity) => (
                <option key={entity} value={entity}>
                  {m.crm.settings.entities[entity]}
                </option>
              ))}
            </SelectField>
            <SelectField
              label={m.crm.settings.fieldType}
              value={form.type}
              onChange={(event) =>
                setForm({ ...form, type: event.target.value as CustomFieldType })
              }
            >
              {CUSTOM_FIELD_TYPES.map((type) => (
                <option key={type} value={type}>
                  {humanize(type)}
                </option>
              ))}
            </SelectField>
            <TextField
              label={m.crm.settings.fieldLabel}
              value={form.label}
              onChange={(event) => {
                const label = event.target.value;
                const suggested = label
                  .toLowerCase()
                  .replace(/[^a-z0-9]+/g, '_')
                  .replace(/^_+|_+$/g, '')
                  .replace(/^(\d)/, 'f_$1')
                  .slice(0, 50);
                setForm((current) => ({
                  ...current,
                  label,
                  key:
                    current.key === '' || current.key === suggestedKey(current.label)
                      ? suggested
                      : current.key,
                }));
              }}
              error={error?.fieldError('label')}
            />
            <TextField
              label={m.crm.settings.fieldKey}
              hint={m.crm.settings.fieldKeyHint}
              value={form.key}
              onChange={(event) => setForm({ ...form, key: event.target.value })}
              error={error?.fieldError('key')}
            />
          </div>
          {isSelect ? (
            <TextAreaField
              label={m.crm.settings.fieldOptions}
              rows={4}
              value={form.options}
              onChange={(event) => setForm({ ...form, options: event.target.value })}
              error={error?.fieldError('options')}
            />
          ) : null}
          <TextField
            label={m.crm.settings.fieldHelp}
            value={form.helpText}
            onChange={(event) => setForm({ ...form, helpText: event.target.value })}
          />
          <CheckboxField
            label={m.crm.settings.fieldRequired}
            checked={form.required}
            onChange={(event) => setForm({ ...form, required: event.target.checked })}
          />
          <Button type="submit" loading={pending}>
            {m.crm.create}
          </Button>
        </form>
      ) : null}
    </Card>
  );
}

function suggestedKey(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^(\d)/, 'f_$1')
    .slice(0, 50);
}
