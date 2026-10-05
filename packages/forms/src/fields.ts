import { normalizeEmail, normalizePhone } from '@businessos/crm';
import { FORM_FIELD_TYPES, type FormField, type FormFieldType } from '@businessos/database';
import { ValidationError, type ErrorDetail } from '@businessos/shared';
import { z } from 'zod';

/** Field types offered by the builder. File uploads arrive with the files service (Phase 16). */
export const BUILDER_FIELD_TYPES = FORM_FIELD_TYPES;

const optionSchema = z.object({
  value: z.string().trim().min(1).max(100),
  label: z.string().trim().min(1).max(200),
});

export const fieldInputSchema = z
  .object({
    key: z
      .string()
      .trim()
      .regex(/^[a-z][a-z0-9_]{0,39}$/, 'Lower-case letters, digits and underscores'),
    type: z.enum(FORM_FIELD_TYPES),
    label: z.string().trim().min(1).max(200),
    required: z.boolean().default(false),
    placeholder: z.string().trim().max(200).nullable().optional(),
    helpText: z.string().trim().max(500).nullable().optional(),
    options: z.array(optionSchema).max(100).default([]),
    validation: z
      .object({
        min: z.number().optional(),
        max: z.number().optional(),
        maxLength: z.number().int().min(1).max(10_000).optional(),
        maxSelections: z.number().int().min(1).max(100).optional(),
      })
      .default({}),
    defaultValue: z.string().max(500).nullable().optional(),
    target: z.string().trim().max(80).nullable().optional(),
  })
  .superRefine((field, ctx) => {
    const choice =
      field.type === 'select' || field.type === 'multi_select' || field.type === 'radio';
    if (choice && field.options.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['options'], message: 'Add at least one option' });
    }
    if (!choice && field.options.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['options'],
        message: 'Only choice fields have options',
      });
    }
    const values = field.options.map((option) => option.value);
    if (new Set(values).size !== values.length) {
      ctx.addIssue({ code: 'custom', path: ['options'], message: 'Option values must be unique' });
    }
    if (
      field.validation.min !== undefined &&
      field.validation.max !== undefined &&
      field.validation.min > field.validation.max
    ) {
      ctx.addIssue({ code: 'custom', path: ['validation'], message: 'Minimum is above maximum' });
    }
    if (field.type === 'hidden' && field.required) {
      ctx.addIssue({
        code: 'custom',
        path: ['required'],
        message: 'Hidden fields cannot be required',
      });
    }
  });
export type FieldInput = z.input<typeof fieldInputSchema>;
export type ParsedField = z.infer<typeof fieldInputSchema>;

/** What the public renderer needs (no mapping targets). */
export interface PublicField {
  key: string;
  type: FormFieldType;
  label: string;
  required: boolean;
  placeholder: string | null;
  helpText: string | null;
  options: { value: string; label: string }[];
  validation: Record<string, number>;
  defaultValue: string | null;
}

export function toPublicField(field: FormField): PublicField {
  return {
    key: field.key,
    type: field.type,
    label: field.label,
    required: field.required,
    placeholder: field.placeholder,
    helpText: field.helpText,
    options: field.options,
    validation: field.validation,
    defaultValue: field.type === 'hidden' ? field.defaultValue : null,
  };
}

const DEFAULT_MAX_LENGTH: Partial<Record<FormFieldType, number>> = {
  text: 500,
  textarea: 10_000,
  hidden: 500,
};
const DECIMAL = /^-?\d{1,15}(\.\d{1,6})?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function isEmpty(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === 'string' && value.trim() === '') ||
    (Array.isArray(value) && value.length === 0) ||
    value === false
  );
}

/**
 * Validates raw answers against a version's fields. Only defined fields are read (anything
 * else is ignored), values are normalized (trimmed text, lower-case email, E.164 phone, decimal
 * numbers as strings) and every problem is reported with its field key.
 */
export function validateAnswers(
  fields: readonly FormField[],
  raw: unknown,
  countryCode: string,
): Record<string, unknown> {
  const input =
    raw !== null && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const answers: Record<string, unknown> = {};
  const errors: ErrorDetail[] = [];
  for (const field of fields) {
    const path = `answers.${field.key}`;
    let value = Object.hasOwn(input, field.key) ? input[field.key] : undefined;
    if (field.type === 'hidden' && isEmpty(value)) value = field.defaultValue ?? undefined;
    if (isEmpty(value)) {
      if (field.required) errors.push({ path, message: 'Required' });
      continue;
    }
    try {
      answers[field.key] = normalizeAnswer(field, value, countryCode, path);
    } catch (error) {
      if (error instanceof ValidationError) {
        errors.push(
          ...(error.details?.length ? error.details : [{ path, message: error.message }]),
        );
      } else throw error;
    }
  }
  if (errors.length > 0) throw new ValidationError('Please check your answers', errors);
  return answers;
}

function normalizeAnswer(
  field: FormField,
  value: unknown,
  countryCode: string,
  path: string,
): unknown {
  const invalid = (message: string): never => {
    throw new ValidationError(message, [{ path, message }]);
  };
  const { min, max } = field.validation;
  switch (field.type) {
    case 'text':
    case 'textarea':
    case 'hidden': {
      if (typeof value !== 'string') return invalid('Must be text');
      const text = value.trim();
      const limit = field.validation.maxLength ?? DEFAULT_MAX_LENGTH[field.type] ?? 500;
      if (text.length > limit) return invalid(`At most ${limit} characters`);
      return text;
    }
    case 'email':
      if (typeof value !== 'string') return invalid('Must be an email address');
      return normalizeEmail(value, path);
    case 'phone':
      if (typeof value !== 'string') return invalid('Must be a phone number');
      return normalizePhone(value, countryCode, path);
    case 'number': {
      const text = typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
      if (typeof text !== 'string' || !DECIMAL.test(text.trim()))
        return invalid('Must be a number');
      const number = Number(text.trim());
      if (min !== undefined && number < min) return invalid(`At least ${min}`);
      if (max !== undefined && number > max) return invalid(`At most ${max}`);
      // Stored as a string: never round-tripped through binary floating point.
      return text.trim();
    }
    case 'date': {
      if (typeof value !== 'string' || !DATE.test(value.trim())) return invalid('Must be a date');
      const date = value.trim();
      const parsed = new Date(`${date}T00:00:00Z`);
      if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
        return invalid('Must be a date');
      }
      return date;
    }
    case 'select':
    case 'radio': {
      if (typeof value !== 'string' || !field.options.some((option) => option.value === value)) {
        return invalid('Choose one of the options');
      }
      return value;
    }
    case 'multi_select': {
      if (!Array.isArray(value)) return invalid('Choose from the options');
      const allowed = new Set(field.options.map((option) => option.value));
      const unique = [...new Set(value)];
      if (!unique.every((item): item is string => typeof item === 'string' && allowed.has(item))) {
        return invalid('Choose from the options');
      }
      const limit = field.validation.maxSelections ?? field.options.length;
      if (unique.length > limit) return invalid(`At most ${limit} choices`);
      return unique;
    }
    case 'checkbox':
    case 'consent': {
      if (value === true || value === 'true' || value === 'on') return true;
      return invalid('Must be checked');
    }
  }
}
