CREATE TABLE "membership_roles" (
	"organization_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "membership_roles_membership_id_role_id_pk" PRIMARY KEY("membership_id","role_id")
);
--> statement-breakpoint
ALTER TABLE "membership_roles" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"system_key" text,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"permissions" text[] DEFAULT '{}'::text[] NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roles_name_length_check" CHECK (char_length("roles"."name") between 1 and 100),
	CONSTRAINT "roles_description_length_check" CHECK (char_length("roles"."description") <= 500),
	CONSTRAINT "roles_system_consistency_check" CHECK (("roles"."is_system" and "roles"."system_key" is not null) or (not "roles"."is_system" and "roles"."system_key" is null)),
	CONSTRAINT "roles_permissions_size_check" CHECK (cardinality("roles"."permissions") <= 500)
);
--> statement-breakpoint
ALTER TABLE "roles" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "invitations" ADD COLUMN "role_id" uuid;
--> statement-breakpoint
CREATE UNIQUE INDEX "roles_id_org_unique" ON "roles" USING btree ("id","organization_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_id_org_unique" ON "memberships" USING btree ("id","organization_id");
--> statement-breakpoint
ALTER TABLE "membership_roles" ADD CONSTRAINT "membership_roles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "membership_roles" ADD CONSTRAINT "membership_roles_membership_fk" FOREIGN KEY ("membership_id","organization_id") REFERENCES "public"."memberships"("id","organization_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "membership_roles" ADD CONSTRAINT "membership_roles_role_fk" FOREIGN KEY ("role_id","organization_id") REFERENCES "public"."roles"("id","organization_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "membership_roles_role_idx" ON "membership_roles" USING btree ("role_id");
--> statement-breakpoint
CREATE INDEX "membership_roles_org_idx" ON "membership_roles" USING btree ("organization_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "roles_org_system_key_unique" ON "roles" USING btree ("organization_id","system_key") WHERE "roles"."system_key" is not null;
--> statement-breakpoint
CREATE UNIQUE INDEX "roles_org_name_unique" ON "roles" USING btree ("organization_id",lower("name"));
--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_role_fk" FOREIGN KEY ("role_id","organization_id") REFERENCES "public"."roles"("id","organization_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "membership_roles" AS PERMISSIVE FOR ALL TO public USING (app_is_system() OR organization_id = app_current_org()) WITH CHECK (app_is_system() OR organization_id = app_current_org());
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "roles" AS PERMISSIVE FOR ALL TO public USING (app_is_system() OR organization_id = app_current_org()) WITH CHECK (app_is_system() OR organization_id = app_current_org());
