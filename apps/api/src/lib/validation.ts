import { ValidationError, type ErrorDetail } from '@businessos/shared';
import type { z } from 'zod';

export function zodIssuesToDetails(issues: readonly z.core.$ZodIssue[]): ErrorDetail[] {
  return issues.map((issue) => ({
    path: issue.path.map(String).join('.') || '(root)',
    message: issue.message,
  }));
}

/**
 * Parses untrusted input with a Zod schema. Unknown object keys are stripped by default Zod
 * object behaviour, which prevents mass assignment of fields that are not explicitly allowed.
 */
export function parseInput<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ValidationError('Invalid input', zodIssuesToDetails(result.error.issues));
  }
  return result.data;
}
