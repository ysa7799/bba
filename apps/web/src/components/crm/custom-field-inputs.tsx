'use client';

import { CheckboxField, SelectField, TextAreaField, TextField } from '@/components/ui/field';
import type { Assignee, CustomFieldDefinition } from '@/lib/crm-types';
import { fromDateTimeLocal, toDateTimeLocal } from '@/lib/format';

/**
 * Inputs for an organization's custom fields. Values are keyed by field key; an empty input is
 * sent as `null` (clears the value). The API validates every value again.
 */
export function CustomFieldInputs({
  fields,
  values,
  onChange,
  errorFor,
  assignees,
}: {
  fields: CustomFieldDefinition[];
  values: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
  errorFor: (path: string) => string | undefined;
  assignees: Assignee[];
}) {
  const active = fields.filter((field) => !field.archived);
  if (active.length === 0) return null;
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {active.map((field) => {
        const value = values[field.key];
        const text = typeof value === 'string' || typeof value === 'number' ? String(value) : '';
        const common = {
          label: field.required ? `${field.label} *` : field.label,
          hint: field.helpText ?? undefined,
          error: errorFor(`customFields.${field.key}`),
        };
        const setText = (next: string) => onChange(field.key, next === '' ? null : next);
        switch (field.type) {
          case 'textarea':
            return (
              <TextAreaField
                key={field.id}
                {...common}
                className="sm:col-span-2"
                rows={3}
                value={text}
                onChange={(event) => setText(event.target.value)}
              />
            );
          case 'boolean':
            return (
              <SelectField
                key={field.id}
                {...common}
                value={value === true ? 'true' : value === false ? 'false' : ''}
                onChange={(event) =>
                  onChange(
                    field.key,
                    event.target.value === '' ? null : event.target.value === 'true',
                  )
                }
              >
                <option value="">—</option>
                <option value="true">Yes</option>
                <option value="false">No</option>
              </SelectField>
            );
          case 'select':
            return (
              <SelectField
                key={field.id}
                {...common}
                value={text}
                onChange={(event) => setText(event.target.value)}
              >
                <option value="">—</option>
                {field.options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </SelectField>
            );
          case 'user':
            return (
              <SelectField
                key={field.id}
                {...common}
                value={text}
                onChange={(event) => setText(event.target.value)}
              >
                <option value="">—</option>
                {assignees.map((assignee) => (
                  <option key={assignee.userId} value={assignee.userId}>
                    {assignee.name}
                  </option>
                ))}
              </SelectField>
            );
          case 'multi_select': {
            const selected = Array.isArray(value) ? (value as string[]) : [];
            return (
              <fieldset key={field.id} className="space-y-1.5">
                <legend className="text-sm font-medium text-slate-800">{common.label}</legend>
                {field.options.map((option) => (
                  <CheckboxField
                    key={option.value}
                    label={option.label}
                    checked={selected.includes(option.value)}
                    onChange={(event) => {
                      const next = event.target.checked
                        ? [...selected, option.value]
                        : selected.filter((item) => item !== option.value);
                      onChange(field.key, next.length === 0 ? null : next);
                    }}
                  />
                ))}
                {common.error ? <p className="text-sm text-red-600">{common.error}</p> : null}
              </fieldset>
            );
          }
          case 'datetime':
            return (
              <TextField
                key={field.id}
                {...common}
                type="datetime-local"
                value={toDateTimeLocal(typeof value === 'string' ? value : null)}
                onChange={(event) => onChange(field.key, fromDateTimeLocal(event.target.value))}
              />
            );
          default:
            return (
              <TextField
                key={field.id}
                {...common}
                type={
                  field.type === 'date'
                    ? 'date'
                    : field.type === 'email'
                      ? 'email'
                      : field.type === 'url'
                        ? 'url'
                        : field.type === 'phone'
                          ? 'tel'
                          : 'text'
                }
                inputMode={
                  field.type === 'integer'
                    ? 'numeric'
                    : field.type === 'decimal'
                      ? 'decimal'
                      : undefined
                }
                value={text}
                onChange={(event) => setText(event.target.value)}
              />
            );
        }
      })}
    </div>
  );
}

/** Read-only rendering of custom field values for detail pages. */
export function CustomFieldValues({
  fields,
  values,
  assignees,
}: {
  fields: CustomFieldDefinition[];
  values: Record<string, unknown>;
  assignees: Assignee[];
}) {
  const active = fields.filter((field) => !field.archived);
  if (active.length === 0) return null;
  const text = (value: unknown): string =>
    typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
      ? String(value)
      : JSON.stringify(value);
  const display = (field: CustomFieldDefinition, value: unknown): string => {
    if (value === undefined || value === null) return '—';
    if (field.type === 'boolean') return value === true ? 'Yes' : 'No';
    if (field.type === 'select')
      return field.options.find((o) => o.value === value)?.label ?? text(value);
    if (field.type === 'multi_select' && Array.isArray(value)) {
      return value
        .map((item) => field.options.find((o) => o.value === item)?.label ?? String(item))
        .join(', ');
    }
    if (field.type === 'user') return assignees.find((a) => a.userId === value)?.name ?? '—';
    return typeof value === 'string' || typeof value === 'number'
      ? String(value)
      : JSON.stringify(value);
  };
  return (
    <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
      {active.map((field) => (
        <div key={field.id}>
          <dt className="text-slate-500">{field.label}</dt>
          <dd className="mt-0.5 break-words text-slate-900">{display(field, values[field.key])}</dd>
        </div>
      ))}
    </dl>
  );
}
