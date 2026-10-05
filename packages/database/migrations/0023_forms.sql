CREATE TABLE "form_fields" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"key" text NOT NULL,
	"type" text NOT NULL,
	"label" text NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"position" integer NOT NULL,
	"placeholder" text,
	"help_text" text,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"validation" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"default_value" text,
	"target" text,
	CONSTRAINT "form_fields_key_check" CHECK ("form_fields"."key" ~ '^[a-z][a-z0-9_]{0,39}$'),
	CONSTRAINT "form_fields_label_check" CHECK (char_length("form_fields"."label") between 1 and 200),
	CONSTRAINT "form_fields_type_check" CHECK ("form_fields"."type" in ('text', 'textarea', 'email', 'phone', 'number', 'date', 'select', 'multi_select', 'checkbox', 'radio', 'hidden', 'consent'))
);
--> statement-breakpoint
ALTER TABLE "form_fields" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "form_submissions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"form_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"answers" jsonb NOT NULL,
	"status" text NOT NULL,
	"spam_reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"processing_notes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"contact_id" uuid,
	"deal_id" uuid,
	"idempotency_key" text NOT NULL,
	"user_agent" text,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "form_submissions_status_check" CHECK ("form_submissions"."status" in ('accepted', 'spam'))
);
--> statement-breakpoint
ALTER TABLE "form_submissions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "form_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"form_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"published_at" timestamp with time zone,
	"published_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "form_versions_status_check" CHECK ("form_versions"."status" in ('draft', 'published', 'retired')),
	CONSTRAINT "form_versions_number_check" CHECK ("form_versions"."number" >= 1)
);
--> statement-breakpoint
ALTER TABLE "form_versions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "forms" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "forms_name_check" CHECK (char_length("forms"."name") between 1 and 120),
	CONSTRAINT "forms_slug_check" CHECK ("forms"."slug" ~ '^[a-z0-9](?:[a-z0-9-]{1,62}[a-z0-9])$'),
	CONSTRAINT "forms_status_check" CHECK ("forms"."status" in ('active', 'archived'))
);
--> statement-breakpoint
ALTER TABLE "forms" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE UNIQUE INDEX "form_fields_version_key_unique" ON "form_fields" USING btree ("version_id","key");
--> statement-breakpoint
CREATE UNIQUE INDEX "form_submissions_id_org_unique" ON "form_submissions" USING btree ("id","organization_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "form_submissions_form_key_unique" ON "form_submissions" USING btree ("form_id","idempotency_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "form_versions_id_org_unique" ON "form_versions" USING btree ("id","organization_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "form_versions_form_number_unique" ON "form_versions" USING btree ("form_id","number");
--> statement-breakpoint
CREATE UNIQUE INDEX "form_versions_one_draft" ON "form_versions" USING btree ("form_id") WHERE "form_versions"."status" = 'draft';
--> statement-breakpoint
CREATE UNIQUE INDEX "form_versions_one_published" ON "form_versions" USING btree ("form_id") WHERE "form_versions"."status" = 'published';
--> statement-breakpoint
CREATE UNIQUE INDEX "forms_id_org_unique" ON "forms" USING btree ("id","organization_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "forms_slug_unique" ON "forms" USING btree ("slug");
--> statement-breakpoint
ALTER TABLE "form_fields" ADD CONSTRAINT "form_fields_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "form_fields" ADD CONSTRAINT "form_fields_version_fk" FOREIGN KEY ("version_id","organization_id") REFERENCES "public"."form_versions"("id","organization_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_form_fk" FOREIGN KEY ("form_id","organization_id") REFERENCES "public"."forms"("id","organization_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_version_fk" FOREIGN KEY ("version_id","organization_id") REFERENCES "public"."form_versions"("id","organization_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_contact_fk" FOREIGN KEY ("contact_id","organization_id") REFERENCES "public"."crm_contacts"("id","organization_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_deal_fk" FOREIGN KEY ("deal_id","organization_id") REFERENCES "public"."crm_deals"("id","organization_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "form_versions" ADD CONSTRAINT "form_versions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "form_versions" ADD CONSTRAINT "form_versions_published_by_user_id_users_id_fk" FOREIGN KEY ("published_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "form_versions" ADD CONSTRAINT "form_versions_form_fk" FOREIGN KEY ("form_id","organization_id") REFERENCES "public"."forms"("id","organization_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "forms" ADD CONSTRAINT "forms_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "forms" ADD CONSTRAINT "forms_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "form_fields_version_idx" ON "form_fields" USING btree ("version_id","position");
--> statement-breakpoint
CREATE INDEX "form_submissions_form_idx" ON "form_submissions" USING btree ("form_id","submitted_at" DESC NULLS LAST,"id" DESC NULLS LAST);
--> statement-breakpoint
CREATE INDEX "form_submissions_contact_idx" ON "form_submissions" USING btree ("contact_id");
--> statement-breakpoint
CREATE INDEX "forms_org_idx" ON "forms" USING btree ("organization_id","status");
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "form_fields" AS PERMISSIVE FOR ALL TO public USING (app_is_system() OR organization_id = app_current_org()) WITH CHECK (app_is_system() OR organization_id = app_current_org());
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "form_submissions" AS PERMISSIVE FOR ALL TO public USING (app_is_system() OR organization_id = app_current_org()) WITH CHECK (app_is_system() OR organization_id = app_current_org());
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "form_versions" AS PERMISSIVE FOR ALL TO public USING (app_is_system() OR organization_id = app_current_org()) WITH CHECK (app_is_system() OR organization_id = app_current_org());
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "forms" AS PERMISSIVE FOR ALL TO public USING (app_is_system() OR organization_id = app_current_org()) WITH CHECK (app_is_system() OR organization_id = app_current_org());
