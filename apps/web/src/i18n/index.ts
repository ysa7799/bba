import { en, type Messages } from './en';

export type Locale = 'en' | 'ar';

// Arabic is wired for RTL layout; its catalogue is added before the language is offered in UI.
const catalogues: Record<Locale, Messages> = { en, ar: en };

export function getMessages(locale: string | null | undefined): Messages {
  return catalogues[locale === 'ar' ? 'ar' : 'en'];
}

export function directionFor(locale: string | null | undefined): 'rtl' | 'ltr' {
  return locale === 'ar' ? 'rtl' : 'ltr';
}

/** Replaces `{name}` placeholders. Values are plain text (React escapes them on render). */
export function format(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
}
