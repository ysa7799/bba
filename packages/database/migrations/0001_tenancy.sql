CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"email_verified_at" timestamp with time zone,
	"password_hash" text,
	"name" text NOT NULL,
	"locale" text DEFAULT 'en' NOT NULL,
	"timezone" text DEFAULT 'Asia/Bahrain' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_status_check" CHECK ("users"."status" in ('active', 'disabled')),
	CONSTRAINT "users_email_normalized_check" CHECK ("users"."email" = lower(btrim("users"."email"))),
	CONSTRAINT "users_name_length_check" CHECK (char_length("users"."name") between 1 and 200)
);
--> statement-breakpoint
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_status_check" CHECK ("memberships"."status" in ('active', 'suspended'))
);
--> statement-breakpoint
ALTER TABLE "memberships" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "organization_settings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_settings_key_format_check" CHECK ("organization_settings"."key" ~ '^[a-z][a-z0-9_.]{1,99}$')
);
--> statement-breakpoint
ALTER TABLE "organization_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"country_code" char(2) DEFAULT 'BH' NOT NULL,
	"default_currency" char(3) DEFAULT 'BHD' NOT NULL,
	"timezone" text DEFAULT 'Asia/Bahrain' NOT NULL,
	"locale" text DEFAULT 'en' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by_user_id" uuid,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_status_check" CHECK ("organizations"."status" in ('active', 'suspended', 'cancelled')),
	CONSTRAINT "organizations_slug_format_check" CHECK ("organizations"."slug" ~ '^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$'),
	CONSTRAINT "organizations_name_length_check" CHECK (char_length("organizations"."name") between 1 and 200),
	CONSTRAINT "organizations_country_check" CHECK ("organizations"."country_code" ~ '^[A-Z]{2}$'),
	CONSTRAINT "organizations_currency_check" CHECK ("organizations"."default_currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
ALTER TABLE "organizations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_settings" ADD CONSTRAINT "organization_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_settings" ADD CONSTRAINT "organization_settings_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "users_created_at_idx" ON "users" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_org_user_unique" ON "memberships" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE INDEX "memberships_user_idx" ON "memberships" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_settings_org_key_unique" ON "organization_settings" USING btree ("organization_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "organizations_slug_unique" ON "organizations" USING btree ("slug");--> statement-breakpoint
CREATE POLICY "users_select" ON "users" AS PERMISSIVE FOR SELECT TO public USING (app_is_system()
        OR "users"."id" = app_current_user()
        OR "users"."id" IN (
          SELECT m.user_id FROM memberships m WHERE m.organization_id = app_current_org()
        ));--> statement-breakpoint
CREATE POLICY "users_modify" ON "users" AS PERMISSIVE FOR ALL TO public USING (app_is_system() OR "users"."id" = app_current_user()) WITH CHECK (app_is_system() OR "users"."id" = app_current_user());--> statement-breakpoint
CREATE POLICY "memberships_select" ON "memberships" AS PERMISSIVE FOR SELECT TO public USING (app_is_system()
        OR "memberships"."organization_id" = app_current_org()
        OR "memberships"."user_id" = app_current_user());--> statement-breakpoint
CREATE POLICY "memberships_insert" ON "memberships" AS PERMISSIVE FOR INSERT TO public WITH CHECK (app_is_system() OR "memberships"."organization_id" = app_current_org());--> statement-breakpoint
CREATE POLICY "memberships_update" ON "memberships" AS PERMISSIVE FOR UPDATE TO public USING (app_is_system() OR "memberships"."organization_id" = app_current_org()) WITH CHECK (app_is_system() OR "memberships"."organization_id" = app_current_org());--> statement-breakpoint
CREATE POLICY "memberships_delete" ON "memberships" AS PERMISSIVE FOR DELETE TO public USING (app_is_system() OR "memberships"."organization_id" = app_current_org());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "organization_settings" AS PERMISSIVE FOR ALL TO public USING (app_is_system() OR organization_id = app_current_org()) WITH CHECK (app_is_system() OR organization_id = app_current_org());--> statement-breakpoint
CREATE POLICY "organizations_select" ON "organizations" AS PERMISSIVE FOR SELECT TO public USING (app_is_system()
        OR "organizations"."id" = app_current_org()
        OR "organizations"."id" IN (
          SELECT m.organization_id FROM memberships m
          WHERE m.user_id = app_current_user() AND m.status = 'active'
        ));--> statement-breakpoint
CREATE POLICY "organizations_modify" ON "organizations" AS PERMISSIVE FOR ALL TO public USING (app_is_system() OR "organizations"."id" = app_current_org()) WITH CHECK (app_is_system() OR "organizations"."id" = app_current_org());