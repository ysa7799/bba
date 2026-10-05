import { ValidationError } from '@businessos/shared';
import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js/max';
import { z } from 'zod';

const emailSchema = z.email();

/** Trimmed, lower-cased email, or a validation error naming `path`. */
export function normalizeEmail(raw: string, path = 'email'): string {
  const value = raw.trim().toLowerCase();
  if (value.length > 254 || !emailSchema.safeParse(value).success) {
    throw new ValidationError('Invalid email address', [
      { path, message: 'Invalid email address' },
    ]);
  }
  return value;
}

/**
 * Normalizes a phone number to E.164. National numbers are read in the organization's country
 * (e.g. "3312 3456" in Bahrain → +97333123456); numbers with a leading + or 00 are international.
 */
export function normalizePhone(raw: string, defaultCountry: string, path = 'phone'): string {
  const trimmed = raw.trim().replace(/^00/, '+');
  const parsed =
    trimmed.length <= 40
      ? parsePhoneNumberFromString(trimmed, defaultCountry.toUpperCase() as CountryCode)
      : undefined;
  if (!parsed?.isValid()) {
    throw new ValidationError('Invalid phone number', [{ path, message: 'Invalid phone number' }]);
  }
  return parsed.number;
}

/** Lower-case host without scheme, credentials, "www.", port or path; IDNs become punycode. */
export function normalizeDomain(raw: string, path = 'domain'): string {
  const value = raw.trim().toLowerCase();
  let host: string;
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(value) ? value : `http://${value}`).hostname;
  } catch {
    host = '';
  }
  host = host.replace(/^www\./, '').replace(/\.$/, '');
  if (
    host.length > 253 ||
    !/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/.test(host)
  ) {
    throw new ValidationError('Invalid domain', [{ path, message: 'Invalid domain' }]);
  }
  return host;
}

/** http(s) URL, normalized by the URL parser. */
export function normalizeUrl(raw: string, path = 'url'): string {
  const value = raw.trim();
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    throw new ValidationError('Invalid URL', [{ path, message: 'Invalid URL' }]);
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.href.length > 2000) {
    throw new ValidationError('Invalid URL', [{ path, message: 'Invalid URL' }]);
  }
  return url.href;
}

/** Optional free text: trimmed, empty → null, length-capped. */
export function optionalText(max: number) {
  return z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((value) => (value === '' ? null : value));
}

export function displayName(contact: {
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  whatsappPhone?: string | null;
}): string {
  const name = [contact.firstName, contact.lastName].filter(Boolean).join(' ').trim();
  if (name !== '') return name;
  return contact.email ?? contact.phone ?? contact.whatsappPhone ?? 'Unnamed contact';
}

/** Escapes LIKE/ILIKE wildcards in user input. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}
