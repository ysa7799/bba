import { z } from 'zod';
import { isValidPath, resolvePath, type RunContext } from './context';

export const CONDITION_OPERATORS = [
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
export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];

const VALUELESS: readonly ConditionOperator[] = ['is_empty', 'is_not_empty'];

export const conditionRuleSchema = z
  .object({
    field: z.string().trim().max(200).refine(isValidPath, 'Unknown field'),
    operator: z.enum(CONDITION_OPERATORS),
    value: z.string().trim().max(500).optional(),
  })
  .superRefine((rule, ctx) => {
    if (!VALUELESS.includes(rule.operator) && !rule.value) {
      ctx.addIssue({ code: 'custom', path: ['value'], message: 'Enter a value' });
    }
    const tagRule = rule.operator === 'has_tag' || rule.operator === 'not_has_tag';
    if (tagRule && rule.field !== 'contact.tags') {
      ctx.addIssue({ code: 'custom', path: ['field'], message: 'Tag rules apply to contact tags' });
    }
    if (tagRule && !z.uuid().safeParse(rule.value).success) {
      ctx.addIssue({ code: 'custom', path: ['value'], message: 'Choose a tag' });
    }
  });
export type ConditionRule = z.infer<typeof conditionRuleSchema>;

export const conditionConfigSchema = z.object({
  match: z.enum(['all', 'any']).default('all'),
  rules: z.array(conditionRuleSchema).min(1).max(10),
});
export type ConditionConfig = z.infer<typeof conditionConfigSchema>;

function isEmpty(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    (typeof value === 'string' && value.trim() === '') ||
    (Array.isArray(value) && value.length === 0)
  );
}

function text(value: unknown): string {
  if (typeof value === 'string') return value.trim().toLowerCase();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value).toLowerCase();
  return '';
}

function number(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value);
  return null;
}

/** Comparisons are case-insensitive; lists match when any element matches. */
export function evaluateRule(rule: ConditionRule, context: RunContext): boolean {
  const actual = resolvePath(context, rule.field);
  const expected = (rule.value ?? '').trim().toLowerCase();
  const values = Array.isArray(actual) ? actual : [actual];
  switch (rule.operator) {
    case 'is_empty':
      return isEmpty(actual);
    case 'is_not_empty':
      return !isEmpty(actual);
    case 'equals':
      return values.some((value) => text(value) === expected);
    case 'not_equals':
      return !values.some((value) => text(value) === expected);
    case 'contains':
      return values.some((value) => text(value).includes(expected));
    case 'not_contains':
      return !values.some((value) => text(value).includes(expected));
    case 'greater_than':
    case 'less_than': {
      const left = number(actual);
      const right = number(rule.value);
      if (left === null || right === null) return false;
      return rule.operator === 'greater_than' ? left > right : left < right;
    }
    case 'has_tag':
      return Array.isArray(actual) && actual.includes(rule.value);
    case 'not_has_tag':
      return !(Array.isArray(actual) && actual.includes(rule.value));
  }
}

export function evaluateCondition(config: ConditionConfig, context: RunContext): boolean {
  return config.match === 'all'
    ? config.rules.every((rule) => evaluateRule(rule, context))
    : config.rules.some((rule) => evaluateRule(rule, context));
}
