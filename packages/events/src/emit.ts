import { outboxEvents, type Tx } from '@businessos/database';
import { newId, ValidationError } from '@businessos/shared';
import { EVENT_DEFINITIONS, type EventActor, type EventPayload, type EventType } from './catalogue';

export interface EmitInput<T extends EventType> {
  type: T;
  organizationId: string | null;
  subject: { type: string; id: string };
  actor: EventActor;
  payload: EventPayload<T>;
  correlationId?: string | null | undefined;
  /** The event that caused this one (loop protection for automation). */
  causationId?: string | null | undefined;
}

/**
 * Records a domain event in the transactional outbox. Must be called inside the transaction
 * that performs the state change, so the event exists if and only if the change committed.
 */
export async function emitEvent<T extends EventType>(tx: Tx, input: EmitInput<T>): Promise<string> {
  const definition = EVENT_DEFINITIONS[input.type];
  const parsed = definition.schema.safeParse(input.payload);
  if (!parsed.success) {
    throw new ValidationError(`Invalid payload for event ${input.type}`);
  }
  const id = newId();
  await tx.insert(outboxEvents).values({
    id,
    organizationId: input.organizationId,
    type: input.type,
    version: definition.version,
    subjectType: input.subject.type,
    subjectId: input.subject.id,
    actorType: input.actor.type,
    actorId: input.actor.id,
    correlationId: input.correlationId ?? null,
    causationId: input.causationId ?? null,
    payload: parsed.data as Record<string, unknown>,
  });
  return id;
}
