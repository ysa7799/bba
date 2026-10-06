# Permissions (RBAC)

Implemented in Phase 4. Code: `packages/permissions` (catalogue + evaluation),
`packages/organizations/src/access.ts` (roles, assignments, guards), API checks in
`apps/api/src/plugins/tenant.ts` (`requirePermission`).

## Model

- **Permission**: `module.resource.action` string from the code catalogue
  (`PERMISSION_DEFINITIONS`). Unknown strings are rejected on write and ignored on read.
- **Role** (`roles` table, per organization):
  - _System roles_ — `owner`, `admin`, `manager`, `member`, `restricted` — are seeded for every
    organization, cannot be edited or deleted, and resolve their permissions **from code**: owners
    hold everything, admins everything not marked `ownerOnly`, lower roles what each catalogue
    entry lists. New permissions therefore reach system roles automatically.
  - _Custom roles_ store an explicit permission list.
- **Assignment** (`membership_roles`): a membership holds one or more roles; effective
  permissions are the union. Composite foreign keys guarantee the membership, role and
  assignment share one organization; assigned roles cannot be deleted (RESTRICT).
- Permissions are re-evaluated on every request, so changes apply immediately.
- **Workspace restrictions**: not yet (no workspace tier, ADR-011).

## Rules (enforced server-side)

1. Endpoints check permissions with `requirePermission`. Members lacking a permission get 403;
   non-members never get past tenant resolution (404).
2. **No escalation**: an actor can only grant (assign, invite with, or define) a role whose
   permissions are a subset of their own. Only owners grant or revoke `owner`.
3. **No managing up**: an actor may change roles of, suspend or remove a member only if that
   member's permissions are a subset of the actor's, and owners can only be managed by owners.
4. An organization always keeps **at least one active owner**; membership/role changes lock the
   organization row so concurrent demotions cannot both succeed.
5. Users cannot suspend or remove themselves through member management (use "leave").
6. Permissions ≠ entitlements ≠ feature flags.
7. Permissions are added to the catalogue in the phase that ships the guarded feature, so custom
   roles never silently gain access to new features.

## Catalogue (current)

| Permission                    | Module         | Owner | Admin | Manager | Member | Restricted |
| ----------------------------- | -------------- | ----- | ----- | ------- | ------ | ---------- |
| `organization.update`         | organization   | ✓     | ✓     |         |        |            |
| `settings.users.manage`       | settings       | ✓     | ✓     |         |        |            |
| `settings.roles.manage`       | settings       | ✓     | ✓     |         |        |            |
| `settings.billing.manage`     | settings       | ✓     | ✓     |         |        |            |
| `audit.read`                  | settings       | ✓     | ✓     |         |        |            |
| `crm.contact.read`            | crm            | ✓     | ✓     | ✓       | ✓      | ✓          |
| `crm.contact.create`          | crm            | ✓     | ✓     | ✓       | ✓      |            |
| `crm.contact.update`          | crm            | ✓     | ✓     | ✓       | ✓      |            |
| `crm.contact.delete`          | crm            | ✓     | ✓     | ✓       |        |            |
| `crm.company.read`            | crm            | ✓     | ✓     | ✓       | ✓      | ✓          |
| `crm.company.create`          | crm            | ✓     | ✓     | ✓       | ✓      |            |
| `crm.company.update`          | crm            | ✓     | ✓     | ✓       | ✓      |            |
| `crm.company.delete`          | crm            | ✓     | ✓     | ✓       |        |            |
| `crm.deal.read`               | crm            | ✓     | ✓     | ✓       | ✓      | ✓          |
| `crm.deal.create`             | crm            | ✓     | ✓     | ✓       | ✓      |            |
| `crm.deal.update`             | crm            | ✓     | ✓     | ✓       | ✓      |            |
| `crm.deal.delete`             | crm            | ✓     | ✓     | ✓       |        |            |
| `crm.pipeline.manage`         | crm            | ✓     | ✓     | ✓       |        |            |
| `crm.task.read`               | crm            | ✓     | ✓     | ✓       | ✓      | ✓          |
| `crm.task.manage`             | crm            | ✓     | ✓     | ✓       | ✓      |            |
| `crm.note.create`             | crm            | ✓     | ✓     | ✓       | ✓      |            |
| `crm.note.manage`             | crm            | ✓     | ✓     | ✓       |        |            |
| `crm.activity.log`            | crm            | ✓     | ✓     | ✓       | ✓      |            |
| `crm.activity.manage`         | crm            | ✓     | ✓     | ✓       |        |            |
| `crm.tag.manage`              | crm            | ✓     | ✓     | ✓       |        |            |
| `crm.custom_field.manage`     | crm            | ✓     | ✓     |         |        |            |
| `crm.data.import`             | crm            | ✓     | ✓     | ✓       |        |            |
| `crm.data.export`             | crm            | ✓     | ✓     | ✓       |        |            |
| `communications.read`         | communications | ✓     | ✓     | ✓       | ✓      | ✓          |
| `communications.send`         | communications | ✓     | ✓     | ✓       | ✓      |            |
| `communications.assign`       | communications | ✓     | ✓     | ✓       | ✓      |            |
| `communications.manage`       | communications | ✓     | ✓     |         |        |            |
| `calendar.appointment.read`   | calendar       | ✓     | ✓     | ✓       | ✓      | ✓          |
| `calendar.appointment.manage` | calendar       | ✓     | ✓     | ✓       | ✓      |            |
| `calendar.manage`             | calendar       | ✓     | ✓     | ✓       |        |            |
| `automation.workflow.read`    | automation     | ✓     | ✓     | ✓       |        |            |
| `automation.workflow.manage`  | automation     | ✓     | ✓     | ✓       |        |            |
| `forms.read`                  | forms          | ✓     | ✓     | ✓       | ✓      | ✓          |
| `forms.manage`                | forms          | ✓     | ✓     | ✓       |        |            |
| `forms.submission.read`       | forms          | ✓     | ✓     | ✓       | ✓      |            |
| `commerce.invoice.read`       | commerce       | ✓     | ✓     | ✓       | ✓      |            |
| `commerce.invoice.create`     | commerce       | ✓     | ✓     | ✓       | ✓      |            |
| `commerce.invoice.update`     | commerce       | ✓     | ✓     | ✓       |        |            |
| `commerce.catalog.manage`     | commerce       | ✓     | ✓     | ✓       |        |            |
| `commerce.payment.refund`     | commerce       | ✓     | ✓     |         |        |            |
| `commerce.settings.manage`    | commerce       | ✓     | ✓     |         |        |            |
| `reports.read`                | reports        | ✓     | ✓     | ✓       | ✓      |            |

Every member may read the organization profile, members, roles and the permission catalogue.

CRM specifics:

- Applying existing tags is part of editing a record; creating/renaming/deleting tags needs
  `crm.tag.manage`. CSV import may create missing tags and companies on the importer's behalf.
- Notes: authors edit/delete their own notes with `crm.note.create`; `crm.note.manage` covers
  everyone's. Reading or writing a note also requires read access to its parent record.
- Linking a record to another (deal → contact, task → deal, contact → company) requires read
  access to the linked record type. Names of linked records the caller cannot read are
  withheld in responses.
- Timeline rows carry the permission needed to see them (deal activities need
  `crm.deal.read`, task activities `crm.task.read`, notes and logged activities the read
  permission of the record they belong to), so a contact's timeline shows each member only
  what they could open elsewhere. Logged activities can be deleted by their author
  (`crm.activity.log`) or a moderator (`crm.activity.manage`); projected history cannot.
- Import requires `crm.data.import` plus create and update on the imported record type.
  Export requires `crm.data.export` plus read on the exported type, re-checked at download;
  exports are downloadable only by the member who requested them.
- Adding CRM permissions made the `member` and `restricted` system roles broader, so a
  delegated member manager without CRM permissions can no longer invite as `member` (the
  subset rule applies to invitations too).

Communications specifics:

- `communications.read` opens the shared inbox and message history; the linked contact's name
  is shown only with `crm.contact.read`. Messages appear on contact timelines for members with
  `communications.read`.
- `communications.send` covers replies and internal notes; starting a conversation from a
  contact also needs `crm.contact.read`. `communications.assign` covers assignment, open/close
  and conversation tags (assignees must be active members).
- `communications.manage` (admins) connects channels, sets credentials (write-only), rotates
  webhook URLs, disconnects and registers templates; other members see only a channel's name,
  provider, address and status.

Calendar specifics:

- `calendar.appointment.read` shows the organization's calendars and appointments (contact
  names only with `crm.contact.read`); appointments appear on contact timelines with it.
- `calendar.appointment.manage` books, reschedules, cancels and marks appointments, and lets a
  member manage their **own** personal calendar (availability, date overrides, external
  connections). Booking for a contact also needs `crm.contact.read`.
- `calendar.manage` covers appointment types, booking pages, shared calendars, everyone's
  availability and connections, and (de)activating calendars.
- Invitees act only through their manage link (a bearer token for one appointment).

Forms specifics:

- `forms.read` shows forms and their configuration; `forms.manage` builds, publishes,
  archives and decides what submissions do in the CRM (owner, lifecycle stage, tags, deals).
- `forms.submission.read` shows answers (personal data) and the form timeline entries on
  contacts. Releasing a submission from spam needs it together with `forms.manage`.
- Submitters are anonymous: they can only answer the defined fields.

Automation specifics:

- `automation.workflow.read` shows workflows, runs and run history (trigger data may contain
  personal data); `automation.workflow.manage` builds, publishes, pauses, archives, issues
  webhook URLs and retries or cancels runs.
- Runs act as the workflow (actor type `workflow`), not as the member who published it; every
  record they reference was validated to belong to the organization when the version was saved
  and published.

Commerce specifics:

- `commerce.invoice.read` shows products, tax rates, quotes, invoices, their payments and the
  quote/invoice entries on contact timelines (customer names only with `crm.contact.read`).
- `commerce.invoice.create` creates and edits **drafts** (and turns quotes into draft
  invoices); `commerce.invoice.update` sends quotes, issues, re-sends and voids invoices and
  records payments received. Members can prepare documents; managers send them.
- `commerce.catalog.manage` maintains products, prices and tax rates.
- `commerce.payment.refund` (owner/admin) refunds payments; `commerce.settings.manage`
  (owner/admin) changes numbering, the invoice footer and the payment provider account.
- Customers act only through their document link (a bearer token for one quote or invoice):
  view, pay what is due, accept or decline.

Reports specifics:

- `reports.read` opens dashboards and reports; each report additionally needs read access to
  its data (e.g. revenue needs `commerce.invoice.read`), so a report never shows what the
  member could not open elsewhere. Names inside reports follow the same rule (customer names
  need `crm.contact.read`). Restricted members have no reports by default.
- Downloading a report as CSV needs the same permissions and is audited.

Files and notifications specifics (Phase 16, no new permissions):

- Attachments follow their record: listing and downloading need the record's read permission,
  uploading and deleting its update permission (`crm.contact.*`, `crm.company.*`,
  `crm.deal.*`).
- Notifications are private to their member. Each type requires a read permission
  (`crm.task.read`, `communications.read`, `crm.deal.read`, `calendar.appointment.read`,
  `commerce.invoice.read`, `automation.workflow.read`), checked again when it is delivered;
  members only see preferences for types they can receive.

Developers specifics (Phase 17):

- `api.manage` (owners and admins) manages API keys and webhook endpoints.
- An API key's scopes are permission keys from the public API's list, and must be held by the
  person creating it. On every request they are narrowed to what that person still holds, and
  the key stops working when they are no longer an active member — a key never does more than
  its creator could do now. Revoking keys of people who leave is still recommended.

## Planned additions (by phase)

`integrations.manage` (18), `white_label.manage` (19),
`ai.use` (20), `projects.*` (21), `support.ticket.*` (22), `marketing.*` (23).
