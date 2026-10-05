import { z } from 'zod';

/**
 * Queues group jobs with similar latency/reliability needs so a backlog in one (e.g. bulk
 * imports) cannot starve another (e.g. transactional email).
 */
export const QUEUE_NAMES = ['system', 'events', 'email', 'data', 'messages'] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];

export interface JobDefinition<Schema extends z.ZodType = z.ZodType> {
  queue: QueueName;
  schema: Schema;
  /** Max attempts before the job is dead-lettered. */
  attempts: number;
}

function defineJob<Schema extends z.ZodType>(definition: JobDefinition<Schema>) {
  return definition;
}

/** Payload of the `email.send` job: a template reference, never pre-rendered HTML. */
export const emailJobSchema = z.object({
  template: z.string().regex(/^[a-z_]+$/),
  to: z.email(),
  locale: z.string().max(10),
  data: z.record(z.string(), z.string().nullable()),
});

/** Registry of every job the platform runs. Payloads are validated on enqueue and on run. */
export const JOBS = {
  'system.ping': defineJob({
    queue: 'system',
    schema: z.object({ sentAt: z.string() }),
    attempts: 1,
  }),
  'event.deliver': defineJob({
    queue: 'events',
    schema: z.object({ eventId: z.uuid(), subscriber: z.string().regex(/^[a-z0-9_-]+$/) }),
    attempts: 8,
  }),
  'email.send': defineJob({ queue: 'email', schema: emailJobSchema, attempts: 6 }),
  'billing.maintenance': defineJob({
    queue: 'system',
    schema: z.object({}),
    attempts: 3,
  }),
  /** CSV import: processes staged rows in resumable batches. */
  'crm.import': defineJob({
    queue: 'data',
    schema: z.object({ organizationId: z.uuid(), importId: z.uuid() }),
    attempts: 5,
  }),
  'crm.export': defineJob({
    queue: 'data',
    schema: z.object({ organizationId: z.uuid(), exportId: z.uuid() }),
    attempts: 3,
  }),
  /** Outbound conversation message through its channel provider. */
  'communications.send': defineJob({
    queue: 'messages',
    schema: z.object({ organizationId: z.uuid(), messageId: z.uuid() }),
    attempts: 5,
  }),
  'crm.maintenance': defineJob({
    queue: 'system',
    schema: z.object({}),
    attempts: 3,
  }),
  /** Appointment reminders that are due (scheduled; idempotent per appointment). */
  'calendar.reminders': defineJob({
    queue: 'system',
    schema: z.object({}),
    attempts: 3,
  }),
  /** Mirrors an appointment to the host's connected external calendars (create or cancel). */
  'calendar.sync': defineJob({
    queue: 'data',
    schema: z.object({ organizationId: z.uuid(), appointmentId: z.uuid() }),
    attempts: 5,
  }),
} as const;

export type JobName = keyof typeof JOBS;
export type JobPayload<N extends JobName> = z.infer<(typeof JOBS)[N]['schema']>;

export function isJobName(value: string): value is JobName {
  return Object.hasOwn(JOBS, value);
}

/** Context carried alongside every job for logging and correlation. */
export interface JobMeta {
  correlationId?: string | undefined;
  organizationId?: string | undefined;
}

export interface EnqueueOptions extends JobMeta {
  /** Deterministic id: enqueueing the same id twice creates one job (idempotent enqueue). */
  jobId?: string;
  delayMs?: number;
}

/** Exponential backoff with full jitter cap, used by every queue. */
export const BACKOFF = { type: 'exponential', delay: 2_000 } as const;
