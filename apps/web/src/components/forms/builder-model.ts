import type { BuilderField, BuilderOptions, FieldOption, FieldType } from '@/lib/forms-types';

/** A field being edited: the API shape plus editor-only state. */
export interface EditableField extends BuilderField {
  uid: string;
  /** Key typed by the user (otherwise derived from the label for new fields). */
  keyEdited: boolean;
  optionsText: string;
}

function asciiSlug(value: string, separator: string): string {
  return value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, separator)
    .replace(new RegExp(`^${separator}+|${separator}+$`, 'g'), '');
}

/** Stored value for an option label (labels in other scripts keep their text as the value). */
export function optionValue(label: string): string {
  return (asciiSlug(label, '_') || label.trim()).slice(0, 100);
}

export function optionsToText(options: FieldOption[]): string {
  return options
    .map((option) =>
      option.value === optionValue(option.label)
        ? option.label
        : `${option.value} | ${option.label}`,
    )
    .join('\n');
}

export function textToOptions(text: string): FieldOption[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const bar = line.indexOf('|');
      if (bar === -1) return { value: optionValue(line), label: line.slice(0, 200) };
      const value = line.slice(0, bar).trim();
      const label = line.slice(bar + 1).trim();
      return { value: value.slice(0, 100), label: (label || value).slice(0, 200) };
    });
}

/** A unique answer key derived from a label (`Company size` → `company_size`). */
export function keyFromLabel(label: string, taken: ReadonlySet<string>): string {
  let base = asciiSlug(label, '_').slice(0, 34) || 'field';
  if (!/^[a-z]/.test(base)) base = `f_${base}`.slice(0, 34);
  let key = base;
  for (let n = 2; taken.has(key); n += 1) key = `${base}_${n}`;
  return key;
}

export function toEditable(field: BuilderField, uid: string): EditableField {
  return { ...field, uid, keyEdited: true, optionsText: optionsToText(field.options) };
}

export function newField(type: FieldType, label: string, key: string, uid: string): EditableField {
  return {
    uid,
    key,
    keyEdited: false,
    type,
    label,
    required: false,
    placeholder: null,
    helpText: null,
    options: [],
    optionsText: '',
    validation: {},
    defaultValue: null,
    target: null,
  };
}

export const isChoice = (type: FieldType) =>
  type === 'select' || type === 'multi_select' || type === 'radio';

/** Request body for one field: only what the field's type uses. */
export function toInput(field: EditableField): Record<string, unknown> {
  const validation: Record<string, number> = {};
  const { min, max, maxLength, maxSelections } = field.validation;
  if (field.type === 'number') {
    if (min !== undefined) validation.min = min;
    if (max !== undefined) validation.max = max;
  }
  if ((field.type === 'text' || field.type === 'textarea') && maxLength !== undefined) {
    validation.maxLength = maxLength;
  }
  if (field.type === 'multi_select' && maxSelections !== undefined) {
    validation.maxSelections = maxSelections;
  }
  return {
    key: field.key,
    type: field.type,
    label: field.label,
    required: field.type === 'hidden' ? false : field.required,
    placeholder: field.placeholder?.trim() ? field.placeholder.trim() : null,
    helpText: field.helpText?.trim() ? field.helpText.trim() : null,
    options: isChoice(field.type) ? textToOptions(field.optionsText) : [],
    validation,
    defaultValue: field.type === 'hidden' && field.defaultValue?.trim() ? field.defaultValue : null,
    target: field.target,
  };
}

export type Target = BuilderOptions['targets'][number];

export function targetsFor(type: FieldType, targets: readonly Target[]): Target[] {
  return targets.filter((target) => target.fieldTypes.includes(type));
}
