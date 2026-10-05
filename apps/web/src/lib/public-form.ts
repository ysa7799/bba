import 'server-only';
import { cache } from 'react';
import type { PublicFormView } from './forms-types';
import { serverPublicGetJson } from './server-api';

const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,62}[a-z0-9])$/;

/** Loads a public form once per request (each load issues a fresh render token). */
export const loadPublicForm = cache((slug: string): Promise<PublicFormView | null> => {
  if (!SLUG.test(slug)) return Promise.resolve(null);
  return serverPublicGetJson<PublicFormView>(`/public/forms/${slug}`);
});

/** Values for hidden fields taken from the link (`?utm_source=…`); nothing else is read. */
export function hiddenPrefill(
  view: PublicFormView,
  query: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const prefill: Record<string, string> = {};
  for (const field of view.form.fields) {
    if (field.type !== 'hidden') continue;
    const value = query[field.key];
    if (typeof value === 'string' && value.trim() !== '') prefill[field.key] = value.slice(0, 500);
  }
  return prefill;
}
