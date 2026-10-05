import { withTenant, type Database, type TenantTx } from '@businessos/database';
import type { DomainEvent, EventSubscriber, EventType } from '@businessos/events';
import { recordActivity, type ActivityInput } from './activities';

/** Turns one domain event into (at most) one activity; null means "not on the timeline". */
export type ActivityProjector = (
  tx: TenantTx,
  event: DomainEvent,
) => Promise<Omit<
  ActivityInput,
  'organizationId' | 'sourceEventId' | 'occurredAt' | 'actor'
> | null>;

export type ProjectorMap = Partial<Record<EventType, ActivityProjector>>;

function actorOf(event: DomainEvent): ActivityInput['actor'] {
  return { type: event.actor.type, userId: event.actor.type === 'user' ? event.actor.id : null };
}

/** Projects one event inside the event's tenant (never system scope). Idempotent per event. */
export async function projectEvent(
  db: Database,
  projectors: ProjectorMap,
  event: DomainEvent,
): Promise<boolean> {
  const projector = projectors[event.type];
  if (!projector || event.organizationId === null) return false;
  const organizationId = event.organizationId;
  return withTenant(db, { organizationId, userId: null }, async (tx) => {
    const projected = await projector(tx, event);
    if (!projected) return false;
    const row = await recordActivity(tx, {
      ...projected,
      organizationId,
      occurredAt: event.occurredAt,
      actor: actorOf(event),
      sourceEventId: event.id,
    });
    return row !== null;
  });
}

/** The `timeline` event subscriber: at-least-once delivery + unique source event = exactly once. */
export function createTimelineSubscriber(db: Database, projectors: ProjectorMap): EventSubscriber {
  return {
    name: 'timeline',
    events: Object.keys(projectors) as EventType[],
    handle: async (event) => {
      await projectEvent(db, projectors, event);
    },
  };
}
