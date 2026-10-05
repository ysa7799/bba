import { LIFECYCLE_STAGES } from '@businessos/database';
import { z } from 'zod';

/**
 * Origins allowed to frame a form (CSP `frame-ancestors`). Strict on purpose: the value is
 * written into a response header, so only `https://host[:port]`, `https://*.host` and local
 * development origins are accepted — never paths, spaces or separators.
 */
const ORIGIN =
  /^(https:\/\/(\*\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+(:\d{1,5})?|http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?)$/;

export const embedOriginSchema = z
  .string()
  .trim()
  .toLowerCase()
  .transform((value) => value.replace(/\/$/, ''))
  .pipe(z.string().max(253).regex(ORIGIN, 'Use an origin such as https://www.example.com'));

/** Where to send the visitor after submitting: https only, no embedded credentials. */
const redirectUrlSchema = z
  .string()
  .trim()
  .max(500)
  .pipe(z.url({ protocol: /^https$/, hostname: z.regexes.domain }))
  .refine((value) => {
    const url = new URL(value);
    return url.username === '' && url.password === '';
  }, 'Credentials are not allowed in the URL');

export const DEFAULT_SUCCESS_MESSAGE = 'Thank you. We have received your submission.';

const contactSettingsSchema = z.object({
  /** Create a contact for new submitters, or fill in missing details of an existing one. */
  enabled: z.boolean().default(true),
  /** Owner of contacts (and deals) created by the form; a fixed member, never the submitter. */
  ownerUserId: z.uuid().nullable().default(null),
  /** Lifecycle stage of new contacts (existing contacts keep theirs). */
  lifecycleStage: z.enum(LIFECYCLE_STAGES).nullable().default(null),
  tagIds: z
    .array(z.uuid())
    .max(20)
    .default([])
    .transform((ids) => [...new Set(ids)]),
  /** Add the answers as a note on the contact (visible to everyone who can see the contact). */
  addNote: z.boolean().default(false),
});

const dealSettingsSchema = z.object({
  pipelineId: z.uuid(),
  /** An open stage of the pipeline; null uses its first open stage. */
  stageId: z.uuid().nullable().default(null),
});

/**
 * Per-version behaviour. Everything that decides what a submission does to the CRM is fixed
 * here by staff; submitters only provide answers to the defined fields.
 */
export const formSettingsSchema = z.object({
  /** Public heading (defaults to the form name). */
  title: z.string().trim().max(120).nullable().default(null),
  description: z.string().trim().max(2_000).nullable().default(null),
  submitLabel: z.string().trim().min(1).max(40).default('Submit'),
  successMessage: z.string().trim().min(1).max(1_000).default(DEFAULT_SUCCESS_MESSAGE),
  redirectUrl: redirectUrlSchema.nullable().default(null),
  contact: contactSettingsSchema.prefault({}),
  deal: dealSettingsSchema.nullable().default(null),
  /** Require a captcha (only when a captcha provider is configured). */
  captcha: z.boolean().default(false),
  /** Sites allowed to embed the form. Empty: the form cannot be embedded. */
  embedOrigins: z
    .array(embedOriginSchema)
    .max(10)
    .default([])
    .transform((origins) => [...new Set(origins)]),
});
export type FormSettings = z.infer<typeof formSettingsSchema>;
export type FormSettingsInput = z.input<typeof formSettingsSchema>;

/** Settings as stored (already validated); tolerant of rows written by older versions. */
export function readSettings(stored: Record<string, unknown>): FormSettings {
  const parsed = formSettingsSchema.safeParse(stored);
  return parsed.success ? parsed.data : formSettingsSchema.parse({});
}
