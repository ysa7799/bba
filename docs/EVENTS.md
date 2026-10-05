# Domain Events

Implemented in Phase 5: `packages/events` (catalogue, `emitEvent`, `OutboxDispatcher`,
`SubscriberRegistry`, `processOnce`), `packages/jobs` (queues), `apps/worker` (runtime).

## Four separate concerns

| Concern           | Purpose                                                                 | Storage                    | Audience             |
| ----------------- | ----------------------------------------------------------------------- | -------------------------- | -------------------- |
| Domain events     | Something happened in the domain; drives automation, timeline, webhooks | `outbox_events`            | Internal subscribers |
| Audit log         | Who did what, for accountability                                        | `audit_logs` (append-only) | Admins, compliance   |
| Outbound webhooks | Customer-facing integration contract                                    | `webhook_deliveries`       | Customer endpoints   |
| Notifications     | Tell a person something                                                 | `notifications`            | Users                |

A domain event may cause an audit record, a webhook delivery and a notification, but each is
produced by its own subscriber with its own retry semantics.

## Envelope

```ts
{
  id: string;              // UUIDv7, idempotency key for consumers
  type: 'contact.created'; // past tense, dot-separated
  version: 1;              // payload schema version
  organizationId: string;
  occurredAt: string;      // ISO-8601 UTC
  actor: { type: 'user' | 'api_key' | 'system' | 'workflow'; id: string | null };
  subject: { type: string; id: string };
  correlationId: string | null;  // request / workflow-run id
  causationId: string | null;    // event that caused this one (loop protection)
  payload: { … };          // Zod-validated per type
}
```

## Delivery

1. `emitEvent(tx, …)` validates the payload against the catalogue and inserts into
   `outbox_events` inside the business transaction (rolled-back changes emit nothing).
2. The worker's `OutboxDispatcher` claims due rows with `FOR UPDATE SKIP LOCKED`, marks them
   `processing` with a lease (`locked_until`) and increments `attempts`.
3. For each registered subscriber it enqueues `event.deliver` with the deterministic job id
   `evt-<eventId>-<subscriber>` (re-dispatch never duplicates a delivery), then marks the row
   `dispatched`.
4. If enqueueing fails the row returns to `pending` with exponential backoff and `last_error`;
   after `maxAttempts` it becomes `failed` (operator-visible). Rows whose lease expired (a
   crashed dispatcher) are reclaimed automatically.
5. `event.deliver` reloads and re-validates the event and calls the subscriber. Failures retry
   with exponential backoff; unrecoverable errors and exhausted retries are recorded in
   `job_failures`.

Delivery is at-least-once. Subscribers that write data use `processOnce(db, subscriber,
eventId, fn)`, which commits a `processed_events` marker with the subscriber's writes. Ordering
is best-effort; consumers must tolerate out-of-order events.

Who emits: domain services emit inside their transactions (organizations, invitations). Audit
records are written by the API layer (or auth services) in the same transaction, because they
need request context (actor, IP, request id).

## Catalogue

Implemented: `organization.created`, `organization.updated`, `member.invited`, `member.joined`,
`member.roles_changed`, `member.removed` (Phase 5); `subscription.started`,
`subscription.changed`, `subscription.canceled` (Phase 6); `payment.succeeded`,
`payment.failed`, `payment.refunded` (Phase 7). The rest arrive with their modules:

organization.created · organization.updated · member.invited · member.joined ·
member.removed · contact.created · contact.updated · contact.deleted · company.created ·
deal.created · deal.stage_changed · deal.won · deal.lost · task.created · task.completed ·
appointment.booked · appointment.rescheduled · appointment.cancelled · form.submitted ·
conversation.created · message.received · message.sent · invoice.created · invoice.sent ·
invoice.paid · invoice.overdue · payment.succeeded · payment.failed · payment.refunded ·
workflow.started · workflow.completed · workflow.failed · ticket.created · ticket.resolved

Each event's payload schema is registered in code; this list is kept in sync.
