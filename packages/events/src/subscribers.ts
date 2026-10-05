import {
  outboxEvents,
  processedEvents,
  withSystem,
  type Database,
  type SystemTx,
} from '@businessos/database';
import { eq } from 'drizzle-orm';
import {
  EVENT_DEFINITIONS,
  isEventType,
  type DomainEvent,
  type EventActorType,
  type EventType,
} from './catalogue';

export interface EventSubscriber {
  /** Stable identifier, `[a-z0-9_-]+`; part of the delivery idempotency key. */
  name: string;
  events: readonly EventType[] | '*';
  handle(event: DomainEvent, context: { attempt: number }): Promise<void>;
}

export class SubscriberRegistry {
  private readonly subscribers = new Map<string, EventSubscriber>();

  register(subscriber: EventSubscriber): this {
    if (!/^[a-z0-9_-]+$/.test(subscriber.name)) {
      throw new Error(`Invalid subscriber name: ${subscriber.name}`);
    }
    if (this.subscribers.has(subscriber.name)) {
      throw new Error(`Duplicate subscriber: ${subscriber.name}`);
    }
    this.subscribers.set(subscriber.name, subscriber);
    return this;
  }

  get(name: string): EventSubscriber | undefined {
    return this.subscribers.get(name);
  }

  namesFor(type: string): string[] {
    return [...this.subscribers.values()]
      .filter(
        (subscriber) => subscriber.events === '*' || subscriber.events.includes(type as EventType),
      )
      .map((subscriber) => subscriber.name);
  }
}

/** Loads and re-validates an event from the outbox for delivery. */
export async function loadEvent(db: Database, eventId: string): Promise<DomainEvent | null> {
  // System scope: the worker delivers events for every tenant.
  const [row] = await withSystem(db, (tx) =>
    tx.select().from(outboxEvents).where(eq(outboxEvents.id, eventId)),
  );
  if (!row || !isEventType(row.type)) return null;
  const payload = EVENT_DEFINITIONS[row.type].schema.parse(row.payload);
  return {
    id: row.id,
    type: row.type,
    version: row.version,
    organizationId: row.organizationId,
    occurredAt: row.occurredAt,
    actor: { type: row.actorType as EventActorType, id: row.actorId },
    subject: { type: row.subjectType, id: row.subjectId },
    correlationId: row.correlationId,
    causationId: row.causationId,
    payload,
  };
}

/**
 * Runs `fn` at most once per (subscriber, event): the marker row and the subscriber's writes
 * commit together, so a crash before commit allows a clean retry and a duplicate delivery after
 * commit is skipped. Returns false when the event was already processed.
 */
export async function processOnce(
  db: Database,
  subscriber: string,
  eventId: string,
  fn: (tx: SystemTx) => Promise<void>,
): Promise<boolean> {
  // System scope: subscriber bookkeeping spans tenants.
  return withSystem(db, async (tx) => {
    const inserted = await tx
      .insert(processedEvents)
      .values({ subscriber, eventId })
      .onConflictDoNothing()
      .returning({ eventId: processedEvents.eventId });
    if (inserted.length === 0) return false;
    await fn(tx);
    return true;
  });
}
