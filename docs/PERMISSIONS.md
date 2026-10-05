# Permissions (RBAC)

_Implemented in Phase 4. This document defines the model._

## Model

- **Permission**: a string `module.resource.action` from a code-defined catalogue
  (`packages/permissions`). Unknown permissions are rejected.
- **Role**: a named set of permissions within an organization. _System roles_ (Owner, Admin,
  Manager, Member, Restricted) are seeded per organization and cannot be edited; _custom roles_
  are organization-defined.
- **Assignment**: a membership holds one or more roles. Effective permissions = union.
- **Workspace restrictions** (later): an assignment may be limited to specific workspaces.

## Rules

1. Checks are server-side (`requirePermission`), evaluated against the membership resolved for
   the request. The UI receives the effective permission list only to hide controls.
2. A user can only grant roles whose permissions are a subset of their own (no escalation).
3. Only Owners can grant Owner or transfer ownership; an organization always keeps ≥ 1 Owner.
4. Role and permission changes are audited and invalidate cached permission sets.
5. Permissions ≠ entitlements ≠ feature flags. A permitted user may still be blocked by the
   plan (entitlement) or a disabled feature flag.

## Catalogue (initial)

```
organization.read  organization.update  organization.delete
settings.users.manage  settings.roles.manage  settings.billing.manage
crm.contact.{read,create,update,delete}  crm.company.{read,create,update,delete}
crm.deal.{read,create,update,delete}  crm.pipeline.manage  crm.task.{read,manage}
calendar.appointment.{read,manage}
communications.{read,send,assign}
automation.workflow.{read,manage}
commerce.invoice.{read,create,update}  commerce.payment.{read,refund}
projects.{read,manage}  support.ticket.{read,manage}
api.manage  integrations.manage  white_label.manage  audit.read
```

The authoritative list lives in code; this table is updated with it.
