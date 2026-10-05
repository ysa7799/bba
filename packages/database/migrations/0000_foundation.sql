-- Foundation: tenant-context helpers used by row-level security policies (ADR-005).
--
-- withTenant() sets `app.org_id` (and `app.user_id`) per transaction; withSystem() sets
-- `app.system = 'on'`. Settings are transaction-local (set_config(..., true)), so they never
-- leak between pooled connections.

CREATE OR REPLACE FUNCTION app_current_org() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT nullif(current_setting('app.org_id', true), '')::uuid $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_current_user() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_is_system() RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT coalesce(current_setting('app.system', true), '') = 'on' $$;
