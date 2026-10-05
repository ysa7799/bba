'use client';

import { useMessages } from '@/components/i18n-provider';
import { Button } from '@/components/ui/button';
import { CheckboxField, SelectField, TextAreaField, TextField } from '@/components/ui/field';
import { format } from '@/i18n';
import { FIELD_TYPES, type FieldType } from '@/lib/forms-types';
import {
  isChoice,
  optionsToText,
  targetsFor,
  type EditableField,
  type Target,
} from './builder-model';

const TEXTUAL: readonly FieldType[] = ['text', 'textarea', 'email', 'phone', 'number'];

function numberOrUndefined(value: string): number | undefined {
  if (value.trim() === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

export function FieldCard({
  field,
  index,
  count,
  targets,
  errors,
  onChange,
  onMove,
  onRemove,
}: {
  field: EditableField;
  index: number;
  count: number;
  targets: readonly Target[];
  errors: (path: string) => string | undefined;
  onChange: (patch: Partial<EditableField>) => void;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
}) {
  const m = useMessages();
  const error = (name: string) => errors(`fields.${index}.${name}`);
  const available = targetsFor(field.type, targets);
  const target = targets.find((entry) => entry.target === field.target) ?? null;
  const optionsLocked = isChoice(field.type) && Boolean(target?.options);
  const targetLabel = (entry: Target) =>
    entry.label
      ? format(m.forms.customField, { label: entry.label })
      : ((m.forms.targets as Record<string, string>)[entry.target] ?? entry.target);

  function changeType(type: FieldType) {
    const keepTarget = targetsFor(type, targets).some((entry) => entry.target === field.target);
    onChange({ type, target: keepTarget ? field.target : null });
  }

  function changeTarget(value: string) {
    const next = targets.find((entry) => entry.target === value) ?? null;
    onChange({
      target: next?.target ?? null,
      ...(next?.options && isChoice(field.type)
        ? { options: next.options, optionsText: optionsToText(next.options) }
        : {}),
    });
  }

  return (
    <li className="rounded-lg border border-slate-200 bg-white p-4" data-field-key={field.key}>
      <div className="grid gap-3 sm:grid-cols-[1fr_12rem]">
        <TextField
          label={m.forms.label}
          value={field.label}
          onChange={(event) => onChange({ label: event.target.value })}
          required
          maxLength={200}
          error={error('label')}
        />
        <SelectField
          label={m.forms.fieldType}
          value={field.type}
          onChange={(event) => changeType(event.target.value as FieldType)}
          error={error('type')}
        >
          {FIELD_TYPES.map((type) => (
            <option key={type} value={type}>
              {m.forms.types[type]}
            </option>
          ))}
        </SelectField>
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <TextField
          label={m.forms.key}
          hint={m.forms.keyHint}
          value={field.key}
          onChange={(event) => onChange({ key: event.target.value, keyEdited: true })}
          maxLength={40}
          pattern="[a-z][a-z0-9_]{0,39}"
          error={error('key')}
          className="font-mono"
        />
        <SelectField
          label={m.forms.mapsTo}
          value={field.target ?? ''}
          onChange={(event) => changeTarget(event.target.value)}
          error={error('target')}
        >
          <option value="">{m.forms.noMapping}</option>
          {available.map((entry) => (
            <option key={entry.target} value={entry.target}>
              {targetLabel(entry)}
            </option>
          ))}
        </SelectField>
        {TEXTUAL.includes(field.type) ? (
          <TextField
            label={m.forms.placeholder}
            value={field.placeholder ?? ''}
            onChange={(event) => onChange({ placeholder: event.target.value })}
            maxLength={200}
          />
        ) : null}
        {field.type !== 'hidden' ? (
          <TextField
            label={m.forms.helpText}
            value={field.helpText ?? ''}
            onChange={(event) => onChange({ helpText: event.target.value })}
            maxLength={500}
          />
        ) : null}
        {field.type === 'number' ? (
          <div className="grid grid-cols-2 gap-3">
            <TextField
              label={m.forms.min}
              type="number"
              value={field.validation.min ?? ''}
              onChange={(event) =>
                onChange({
                  validation: { ...field.validation, min: numberOrUndefined(event.target.value) },
                })
              }
            />
            <TextField
              label={m.forms.max}
              type="number"
              value={field.validation.max ?? ''}
              onChange={(event) =>
                onChange({
                  validation: { ...field.validation, max: numberOrUndefined(event.target.value) },
                })
              }
              error={error('validation')}
            />
          </div>
        ) : null}
        {field.type === 'text' || field.type === 'textarea' ? (
          <TextField
            label={m.forms.maxLength}
            type="number"
            min={1}
            max={10_000}
            value={field.validation.maxLength ?? ''}
            onChange={(event) =>
              onChange({
                validation: {
                  ...field.validation,
                  maxLength: numberOrUndefined(event.target.value),
                },
              })
            }
          />
        ) : null}
        {field.type === 'multi_select' ? (
          <TextField
            label={m.forms.maxSelections}
            type="number"
            min={1}
            max={100}
            value={field.validation.maxSelections ?? ''}
            onChange={(event) =>
              onChange({
                validation: {
                  ...field.validation,
                  maxSelections: numberOrUndefined(event.target.value),
                },
              })
            }
          />
        ) : null}
        {field.type === 'hidden' ? (
          <TextField
            label={m.forms.defaultValue}
            hint={format(m.forms.defaultValueHint, { key: field.key })}
            value={field.defaultValue ?? ''}
            onChange={(event) => onChange({ defaultValue: event.target.value })}
            maxLength={500}
          />
        ) : null}
      </div>
      {isChoice(field.type) ? (
        <TextAreaField
          className="mt-3"
          label={m.forms.options}
          hint={optionsLocked ? m.forms.optionsFromField : m.forms.optionsHint}
          rows={4}
          value={field.optionsText}
          readOnly={optionsLocked}
          onChange={(event) => onChange({ optionsText: event.target.value })}
          error={error('options')}
        />
      ) : null}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        {field.type === 'hidden' ? (
          <span />
        ) : (
          <CheckboxField
            label={m.forms.required}
            checked={field.required}
            onChange={(event) => onChange({ required: event.target.checked })}
          />
        )}
        <div className="flex gap-1">
          <Button
            size="sm"
            variant="ghost"
            disabled={index === 0}
            onClick={() => onMove(-1)}
            aria-label={`${m.forms.moveUp}: ${field.label}`}
          >
            ↑
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={index === count - 1}
            onClick={() => onMove(1)}
            aria-label={`${m.forms.moveDown}: ${field.label}`}
          >
            ↓
          </Button>
          <Button size="sm" variant="ghost" onClick={onRemove} disabled={count === 1}>
            {m.forms.remove}
          </Button>
        </div>
      </div>
    </li>
  );
}
