# Domain Events

_Infrastructure lands in Phase 5._

## Four separate concerns

| Concern | Purpose | Storage | Audience |
| --- | --- | --- | --- |
| Domain events | Something happened in the domain; drives automation, timeline, webhooks | `outbox_events` | Internal subscribers |
| Audit log | Who did what, for accountability | `audit_logs` (append-only) | Admins, compliance |
| Outbound webhooks | Customer-facing integration contract | `webhook_deliveries` | Customer endpoints |
| Notifications | Tell a person something | `notifications` | Users |

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

Written to `outbox_events` in the business transaction → dispatcher claims with
`FOR UPDATE SKIP LOCKED` → one job per subscriber → subscribers are idempotent on
`(event.id, subscriber)`. At-least-once delivery; ordering is per-subject best-effort, so
consumers must tolerate out-of-order events (compare versions/timestamps).

## Catalogue

organization.created · organization.updated · member.invited · member.joined ·
member.removed · contact.created · contact.updated · contact.deleted · company.created ·
deal.created · deal.stage_changed · deal.won · deal.lost · task.created · task.completed ·
appointment.booked · appointment.rescheduled · appointment.cancelled · form.submitted ·
conversation.created · message.received · message.sent · invoice.created · invoice.sent ·
invoice.paid · invoice.overdue · payment.succeeded · payment.failed · payment.refunded ·
workflow.started · workflow.completed · workflow.failed · ticket.created · ticket.resolved

Each event's payload schema is registered in code; this list is kept in sync.
