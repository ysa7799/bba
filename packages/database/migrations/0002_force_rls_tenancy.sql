-- FORCE row-level security so policies also apply to the table owner (defense in depth for
-- scripts that run as the owner role without being superuser). See ADR-005.
ALTER TABLE "users" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "organizations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "memberships" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "organization_settings" FORCE ROW LEVEL SECURITY;
