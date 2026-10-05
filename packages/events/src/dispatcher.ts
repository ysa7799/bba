import { outboxEvents, withSystem, type Database } from '@businessos/database';
import type { JobQueue } from '@businessos/jobs';
import { and, eq, sql } from 'drizzle-orm';
import type { SubscriberRegistry } from './subscribers';

export interface DispatcherOptions {
  batchSize?: number;
  /** How long a claimed batch is reserved before another dispatcher may reclaim it. */
  leaseMs?: number;
  /** Attempts before an event is marked `failed` (visible for operators). */
  maxAttempts?: number;
  logger?: {
    error: (obj: object, msg: string) => void;
    debug?: (obj: object, msg: string) => void;
  };
}

interface ClaimedEvent {
  id: string;
  type: string;
  organization_id: string | null;
  correlation_id: string | null;
  attempts: number;
}

export function deliveryJobId(eventId: string, subscriber: string): string {
  return `evt-${eventId}-${subscriber}`;
}

/**
 * Moves committed outbox events to subscriber jobs. Safe to run in several worker processes:
 * claims use `FOR UPDATE SKIP LOCKED`, claimed rows carry a lease, and job ids are deterministic
 * so re-dispatching an event never creates duplicate deliveries.
 */
export class OutboxDispatcher {
  private readonly batchSize: number;
  private readonly leaseMs: number;
  private readonly maxAttempts: number;

  constructor(
    private readonly db: Database,
    private readonly queue: JobQueue,
    private readonly registry: SubscriberRegistry,
    private readonly options: DispatcherOptions = {},
  ) {
    this.batchSize = options.batchSize ?? 100;
    this.leaseMs = options.leaseMs ?? 60_000;
    this.maxAttempts = options.maxAttempts ?? 10;
  }

  private async claim(): Promise<ClaimedEvent[]> {
    // System scope: the dispatcher serves every tenant.
    return withSystem(this.db, async (tx) => {
      const result = await tx.execute<ClaimedEvent & Record<string, unknown>>(sql`
        UPDATE outbox_events
        SET status = 'processing',
            locked_until = now() + (${this.leaseMs}::int * interval '1 millisecond'),
            attempts = attempts + 1
        WHERE id IN (
          SELECT id FROM outbox_events
          WHERE (status = 'pending' AND available_at <= now())
             OR (status = 'processing' AND locked_until < now())
          ORDER BY available_at, id
          LIMIT ${this.batchSize}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING id, type, organization_id, correlation_id, attempts
      `);
      return result.rows;
    });
  }

  /** Dispatches one batch; returns the number of events handled. */
  async dispatchBatch(): Promise<number> {
    const claimed = await this.claim();
    for (const event of claimed) {
      try {
        for (const subscriber of this.registry.namesFor(event.type)) {
          await this.queue.enqueue(
            'event.deliver',
            { eventId: event.id, subscriber },
            {
              jobId: deliveryJobId(event.id, subscriber),
              correlationId: event.correlation_id ?? undefined,
              organizationId: event.organization_id ?? undefined,
            },
          );
        }
        await withSystem(this.db, (tx) =>
          tx
            .update(outboxEvents)
            .set({
              status: 'dispatched',
              dispatchedAt: new Date(),
              lockedUntil: null,
              lastError: null,
            })
            .where(and(eq(outboxEvents.id, event.id), eq(outboxEvents.status, 'processing'))),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const exhausted = event.attempts >= this.maxAttempts;
        const backoffMs = Math.min(5 * 60_000, 1_000 * 2 ** Math.min(event.attempts, 8));
        this.options.logger?.error(
          { eventId: event.id, err: error, exhausted },
          'outbox dispatch failed',
        );
        await withSystem(this.db, (tx) =>
          tx
            .update(outboxEvents)
            .set({
              status: exhausted ? 'failed' : 'pending',
              availableAt: new Date(Date.now() + backoffMs),
              lockedUntil: null,
              lastError: message.slice(0, 2_000),
            })
            .where(eq(outboxEvents.id, event.id)),
        );
      }
    }
    return claimed.length;
  }

  /**
   * Polls until stopped. Drains continuously while full batches are found, otherwise waits
   * `idleMs` between polls. The returned function stops the loop and waits for it to finish.
   */
  start(idleMs = 500): () => Promise<void> {
    // An object (not a boolean) so the flag's mutation from `stop` is visible to the loop.
    const state = { stopped: false };
    const isStopped = () => state.stopped;
    let timer: NodeJS.Timeout | undefined;
    let wake: () => void = () => undefined;
    const loop = (async () => {
      while (!isStopped()) {
        let handled = 0;
        try {
          handled = await this.dispatchBatch();
        } catch (error) {
          this.options.logger?.error({ err: error }, 'outbox dispatcher iteration failed');
        }
        if (handled < this.batchSize && !isStopped()) {
          await new Promise<void>((resolve) => {
            wake = resolve;
            timer = setTimeout(resolve, idleMs);
          });
        }
      }
    })();
    return async () => {
      state.stopped = true;
      clearTimeout(timer);
      wake();
      await loop;
    };
  }
}
