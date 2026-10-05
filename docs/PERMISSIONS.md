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

| Permission                | Module       | Owner | Admin | Manager | Member | Restricted |
| ------------------------- | ------------ | ----- | ----- | ------- | ------ | ---------- |
| `organization.update`     | organization | ✓     | ✓     |         |        |            |
| `settings.users.manage`   | settings     | ✓     | ✓     |         |        |            |
| `settings.roles.manage`   | settings     | ✓     | ✓     |         |        |            |
| `settings.billing.manage` | settings     | ✓     | ✓     |         |        |            |
| `audit.read`              | settings     | ✓     | ✓     |         |        |            |
| `crm.contact.read`        | crm          | ✓     | ✓     | ✓       | ✓      | ✓          |
| `crm.contact.create`      | crm          | ✓     | ✓     | ✓       | ✓      |            |
| `crm.contact.update`      | crm          | ✓     | ✓     | ✓       | ✓      |            |
| `crm.contact.delete`      | crm          | ✓     | ✓     | ✓       |        |            |
| `crm.company.read`        | crm          | ✓     | ✓     | ✓       | ✓      | ✓          |
| `crm.company.create`      | crm          | ✓     | ✓     | ✓       | ✓      |            |
| `crm.company.update`      | crm          | ✓     | ✓     | ✓       | ✓      |            |
| `crm.company.delete`      | crm          | ✓     | ✓     | ✓       |        |            |
| `crm.deal.read`           | crm          | ✓     | ✓     | ✓       | ✓      | ✓          |
| `crm.deal.create`         | crm          | ✓     | ✓     | ✓       | ✓      |            |
| `crm.deal.update`         | crm          | ✓     | ✓     | ✓       | ✓      |            |
| `crm.deal.delete`         | crm          | ✓     | ✓     | ✓       |        |            |
| `crm.pipeline.manage`     | crm          | ✓     | ✓     | ✓       |        |            |
| `crm.task.read`           | crm          | ✓     | ✓     | ✓       | ✓      | ✓          |
| `crm.task.manage`         | crm          | ✓     | ✓     | ✓       | ✓      |            |
| `crm.note.create`         | crm          | ✓     | ✓     | ✓       | ✓      |            |
| `crm.note.manage`         | crm          | ✓     | ✓     | ✓       |        |            |
| `crm.tag.manage`          | crm          | ✓     | ✓     | ✓       |        |            |
| `crm.custom_field.manage` | crm          | ✓     | ✓     |         |        |            |
| `crm.data.import`         | crm          | ✓     | ✓     | ✓       |        |            |
| `crm.data.export`         | crm          | ✓     | ✓     | ✓       |        |            |

Every member may read the organization profile, members, roles and the permission catalogue.

CRM specifics:

- Applying existing tags is part of editing a record; creating/renaming/deleting tags needs
  `crm.tag.manage`. CSV import may create missing tags and companies on the importer's behalf.
- Notes: authors edit/delete their own notes with `crm.note.create`; `crm.note.manage` covers
  everyone's. Reading or writing a note also requires read access to its parent record.
- Linking a record to another (deal → contact, task → deal, contact → company) requires read
  access to the linked record type. Names of linked records the caller cannot read are
  withheld in responses.
- Import requires `crm.data.import` plus create and update on the imported record type.
  Export requires `crm.data.export` plus read on the exported type, re-checked at download;
  exports are downloadable only by the member who requested them.
- Adding CRM permissions made the `member` and `restricted` system roles broader, so a
  delegated member manager without CRM permissions can no longer invite as `member` (the
  subset rule applies to invitations too).

## Planned additions (by phase)

`communications.*` (10),
`calendar.*` (11), `forms.*` (12), `automation.workflow.*` (13), `commerce.*` (14),
`reports.read` (15), `api.manage` (17), `integrations.manage` (18), `white_label.manage` (19),
`ai.use` (20), `projects.*` (21), `support.ticket.*` (22), `marketing.*` (23).
