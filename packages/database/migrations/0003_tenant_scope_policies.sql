ALTER POLICY "memberships_select" ON "memberships" TO public USING (app_is_system()
        OR "memberships"."organization_id" = app_current_org()
        OR (app_current_org() IS NULL AND "memberships"."user_id" = app_current_user()));--> statement-breakpoint
ALTER POLICY "organizations_select" ON "organizations" TO public USING (app_is_system()
        OR "organizations"."id" = app_current_org()
        OR (app_current_org() IS NULL AND "organizations"."id" IN (
          SELECT m.organization_id FROM memberships m
          WHERE m.user_id = app_current_user() AND m.status = 'active'
        )));