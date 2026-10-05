import { isCurrencyCode, type CurrencyCode } from '@businessos/shared';
import { z } from 'zod';

export const SUPPORTED_LOCALES = ['en', 'ar'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export function isValidTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const regionNames = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' });

export function isValidCountryCode(value: string): boolean {
  if (!/^[A-Z]{2}$/.test(value)) return false;
  return regionNames.of(value) !== undefined;
}

export const timezoneSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(isValidTimezone, { message: 'Unknown IANA timezone' });

export const countryCodeSchema = z
  .string()
  .transform((value) => value.toUpperCase())
  .refine(isValidCountryCode, { message: 'Unknown ISO country code' });

export const currencySchema = z
  .string()
  .transform((value) => value.toUpperCase())
  .refine((value): value is CurrencyCode => isCurrencyCode(value), {
    message: 'Unsupported currency',
  });

export const localeSchema = z.enum(SUPPORTED_LOCALES);

export const organizationNameSchema = z.string().trim().min(1).max(200);

export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$/, {
    message: '3–48 characters: lowercase letters, digits and hyphens',
  });

export const createOrganizationInputSchema = z.object({
  name: organizationNameSchema,
  slug: slugSchema.optional(),
  countryCode: countryCodeSchema.default('BH'),
  defaultCurrency: currencySchema.default('BHD'),
  timezone: timezoneSchema.default('Asia/Bahrain'),
  locale: localeSchema.default('en'),
});

export type CreateOrganizationInput = z.input<typeof createOrganizationInputSchema>;

/** Fields an authorized member may change. Status, slug and ownership are not here. */
export const updateOrganizationInputSchema = z
  .object({
    name: organizationNameSchema,
    countryCode: countryCodeSchema,
    defaultCurrency: currencySchema,
    timezone: timezoneSchema,
    locale: localeSchema,
  })
  .partial();

export type UpdateOrganizationInput = z.input<typeof updateOrganizationInputSchema>;

/** Derives a URL-safe slug base from a display name (non-Latin names fall back to "org"). */
export function slugBaseFromName(name: string): string {
  const base = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return base.length >= 3 ? base : 'org';
}
