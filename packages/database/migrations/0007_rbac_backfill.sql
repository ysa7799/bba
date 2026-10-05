-- Backfill RBAC for organizations created before roles existed, then FORCE RLS on new tables.
-- Runs with system scope so it also works when the migration role is not a superuser.
SELECT set_config('app.system', 'on', false);
--> statement-breakpoint
INSERT INTO roles (id, organization_id, system_key, name, description, is_system)
SELECT gen_random_uuid(), o.id, r.key, r.name, r.description, true
FROM organizations o
CROSS JOIN (VALUES
  ('owner', 'Owner', 'Full access, including ownership-only actions.'),
  ('admin', 'Admin', 'Full access except ownership-only actions.'),
  ('manager', 'Manager', 'Manages team work and shared settings.'),
  ('member', 'Member', 'Works with customers and records.'),
  ('restricted', 'Restricted', 'Limited, mostly read-only access.')
) AS r(key, name, description)
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- The creator becomes owner; organizations whose creator left get their earliest member as owner.
WITH owner_membership AS (
  SELECT DISTINCT ON (o.id) o.id AS organization_id, m.id AS membership_id
  FROM organizations o
  JOIN memberships m ON m.organization_id = o.id AND m.status = 'active'
  ORDER BY o.id, (m.user_id = o.created_by_user_id) DESC, m.joined_at ASC
)
INSERT INTO membership_roles (organization_id, membership_id, role_id)
SELECT om.organization_id, om.membership_id, r.id
FROM owner_membership om
JOIN roles r ON r.organization_id = om.organization_id AND r.system_key = 'owner'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO membership_roles (organization_id, membership_id, role_id)
SELECT m.organization_id, m.id, r.id
FROM memberships m
JOIN roles r ON r.organization_id = m.organization_id AND r.system_key = 'member'
WHERE NOT EXISTS (SELECT 1 FROM membership_roles mr WHERE mr.membership_id = m.id)
ON CONFLICT DO NOTHING;
--> statement-breakpoint
UPDATE invitations i
SET role_id = r.id
FROM roles r
WHERE r.organization_id = i.organization_id AND r.system_key = 'member' AND i.role_id IS NULL;
--> statement-breakpoint
ALTER TABLE "roles" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "membership_roles" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
SELECT set_config('app.system', '', false);
