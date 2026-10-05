/**
 * Queue names. Each queue groups jobs with similar latency/reliability needs so a backlog in
 * one (e.g. bulk imports) cannot starve another (e.g. transactional email).
 */
export const QUEUES = {
  system: 'system',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export const DEFAULT_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 2_000 },
  removeOnComplete: { age: 24 * 3600, count: 1_000 },
  // Failed jobs are retained for inspection (dead-letter visibility).
  removeOnFail: { age: 14 * 24 * 3600 },
} as const;
