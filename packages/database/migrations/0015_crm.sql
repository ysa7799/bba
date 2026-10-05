CREATE TABLE "crm_companies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"domain" text,
	"phone" text,
	"website" text,
	"industry" text,
	"employee_count" integer,
	"city" text,
	"country_code" char(2),
	"owner_user_id" uuid,
	"custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by_user_id" uuid,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', coalesce(name, '') || ' ' || coalesce(domain, '') || ' ' || coalesce(phone, '') || ' ' || coalesce(industry, '') || ' ' || coalesce(city, ''))) STORED,
	CONSTRAINT "crm_companies_name_check" CHECK (char_length("crm_companies"."name") between 1 and 200),
	CONSTRAINT "crm_companies_employee_count_check" CHECK ("crm_companies"."employee_count" is null or "crm_companies"."employee_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "crm_companies" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "crm_company_tags" (
	"organization_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crm_company_tags_company_id_tag_id_pk" PRIMARY KEY("company_id","tag_id")
);
--> statement-breakpoint
ALTER TABLE "crm_company_tags" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "crm_contact_companies" (
	"organization_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"role" text,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crm_contact_companies_contact_id_company_id_pk" PRIMARY KEY("contact_id","company_id")
);
--> statement-breakpoint
ALTER TABLE "crm_contact_companies" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "crm_contact_tags" (
	"organization_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crm_contact_tags_contact_id_tag_id_pk" PRIMARY KEY("contact_id","tag_id")
);
--> statement-breakpoint
ALTER TABLE "crm_contact_tags" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "crm_contacts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"first_name" text,
	"last_name" text,
	"email" text,
	"phone" text,
	"whatsapp_phone" text,
	"job_title" text,
	"owner_user_id" uuid,
	"source" text DEFAULT 'manual' NOT NULL,
	"lifecycle_stage" text DEFAULT 'lead' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by_user_id" uuid,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', coalesce(first_name, '') || ' ' || coalesce(last_name, '') || ' ' || coalesce(email, '') || ' ' || coalesce(phone, '') || ' ' || coalesce(whatsapp_phone, '') || ' ' || coalesce(job_title, ''))) STORED,
	CONSTRAINT "crm_contacts_identity_check" CHECK (coalesce("crm_contacts"."first_name", "crm_contacts"."last_name", "crm_contacts"."email", "crm_contacts"."phone", "crm_contacts"."whatsapp_phone") is not null),
	CONSTRAINT "crm_contacts_email_check" CHECK ("crm_contacts"."email" is null or "crm_contacts"."email" = lower(btrim("crm_contacts"."email"))),
	CONSTRAINT "crm_contacts_phone_check" CHECK ("crm_contacts"."phone" is null or "crm_contacts"."phone" ~ '^\+[1-9][0-9]{6,14}$'),
	CONSTRAINT "crm_contacts_whatsapp_check" CHECK ("crm_contacts"."whatsapp_phone" is null or "crm_contacts"."whatsapp_phone" ~ '^\+[1-9][0-9]{6,14}$'),
	CONSTRAINT "crm_contacts_lifecycle_check" CHECK ("crm_contacts"."lifecycle_stage" in ('subscriber', 'lead', 'qualified', 'opportunity', 'customer', 'evangelist', 'other')),
	CONSTRAINT "crm_contacts_status_check" CHECK ("crm_contacts"."status" in ('active', 'inactive'))
);
--> statement-breakpoint
ALTER TABLE "crm_contacts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "crm_custom_fields" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"type" text NOT NULL,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"help_text" text,
	"position" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crm_custom_fields_key_check" CHECK ("crm_custom_fields"."key" ~ '^[a-z][a-z0-9_]{0,49}$'),
	CONSTRAINT "crm_custom_fields_label_check" CHECK (char_length("crm_custom_fields"."label") between 1 and 100),
	CONSTRAINT "crm_custom_fields_entity_check" CHECK ("crm_custom_fields"."entity_type" in ('contact', 'company', 'deal'))
);
--> statement-breakpoint
ALTER TABLE "crm_custom_fields" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "crm_deal_tags" (
	"organization_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	"deal_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crm_deal_tags_deal_id_tag_id_pk" PRIMARY KEY("deal_id","tag_id")
);
--> statement-breakpoint
ALTER TABLE "crm_deal_tags" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "crm_deals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"pipeline_id" uuid NOT NULL,
	"stage_id" uuid NOT NULL,
	"contact_id" uuid,
	"company_id" uuid,
	"owner_user_id" uuid,
	"value_minor" bigint,
	"currency" char(3) NOT NULL,
	"probability" integer,
	"expected_close_date" date,
	"status" text DEFAULT 'open' NOT NULL,
	"closed_at" timestamp with time zone,
	"lost_reason" text,
	"stage_entered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"position" double precision DEFAULT 0 NOT NULL,
	"custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by_user_id" uuid,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', coalesce(name, '') || ' ' || coalesce(lost_reason, ''))) STORED,
	CONSTRAINT "crm_deals_name_check" CHECK (char_length("crm_deals"."name") between 1 and 200),
	CONSTRAINT "crm_deals_value_check" CHECK ("crm_deals"."value_minor" is null or "crm_deals"."value_minor" >= 0),
	CONSTRAINT "crm_deals_currency_check" CHECK ("crm_deals"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "crm_deals_probability_check" CHECK ("crm_deals"."probability" is null or "crm_deals"."probability" between 0 and 100),
	CONSTRAINT "crm_deals_status_check" CHECK ("crm_deals"."status" in ('open', 'won', 'lost'))
);
--> statement-breakpoint
ALTER TABLE "crm_deals" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "crm_exports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"filters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"row_count" integer,
	"content" text,
	"content_bytes" integer,
	"failure_reason" text,
	"download_count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crm_exports_status_check" CHECK ("crm_exports"."status" in ('queued', 'processing', 'completed', 'failed', 'expired')),
	CONSTRAINT "crm_exports_entity_check" CHECK ("crm_exports"."entity_type" in ('contact', 'company', 'deal'))
);
--> statement-breakpoint
ALTER TABLE "crm_exports" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "crm_import_rows" (
	"organization_id" uuid NOT NULL,
	"import_id" uuid NOT NULL,
	"row_number" integer NOT NULL,
	"values" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"record_id" uuid,
	CONSTRAINT "crm_import_rows_import_id_row_number_pk" PRIMARY KEY("import_id","row_number"),
	CONSTRAINT "crm_import_rows_status_check" CHECK ("crm_import_rows"."status" in ('pending', 'created', 'updated', 'skipped', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "crm_import_rows" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "crm_imports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"status" text DEFAULT 'uploaded' NOT NULL,
	"file_name" text NOT NULL,
	"headers" jsonb NOT NULL,
	"mapping" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"duplicate_policy" text DEFAULT 'skip' NOT NULL,
	"total_rows" integer DEFAULT 0 NOT NULL,
	"processed_rows" integer DEFAULT 0 NOT NULL,
	"created_count" integer DEFAULT 0 NOT NULL,
	"updated_count" integer DEFAULT 0 NOT NULL,
	"skipped_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"failure_reason" text,
	"created_by_user_id" uuid,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crm_imports_status_check" CHECK ("crm_imports"."status" in ('uploaded', 'queued', 'processing', 'completed', 'failed', 'canceled')),
	CONSTRAINT "crm_imports_entity_check" CHECK ("crm_imports"."entity_type" in ('contact', 'company')),
	CONSTRAINT "crm_imports_duplicate_policy_check" CHECK ("crm_imports"."duplicate_policy" in ('skip', 'update'))
);
--> statement-breakpoint
ALTER TABLE "crm_imports" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "crm_notes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"body" text NOT NULL,
	"contact_id" uuid,
	"company_id" uuid,
	"deal_id" uuid,
	"author_user_id" uuid,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crm_notes_body_check" CHECK (char_length("crm_notes"."body") between 1 and 20000),
	CONSTRAINT "crm_notes_one_parent_check" CHECK (num_nonnulls("crm_notes"."contact_id", "crm_notes"."company_id", "crm_notes"."deal_id") = 1)
);
--> statement-breakpoint
ALTER TABLE "crm_notes" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "crm_pipeline_stages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"pipeline_id" uuid NOT NULL,
	"name" text NOT NULL,
	"position" integer NOT NULL,
	"probability" integer DEFAULT 0 NOT NULL,
	"kind" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crm_pipeline_stages_probability_check" CHECK ("crm_pipeline_stages"."probability" between 0 and 100),
	CONSTRAINT "crm_pipeline_stages_kind_check" CHECK ("crm_pipeline_stages"."kind" in ('open', 'won', 'lost')),
	CONSTRAINT "crm_pipeline_stages_name_check" CHECK (char_length("crm_pipeline_stages"."name") between 1 and 100)
);
--> statement-breakpoint
ALTER TABLE "crm_pipeline_stages" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "crm_pipelines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crm_pipelines_name_check" CHECK (char_length("crm_pipelines"."name") between 1 and 100)
);
--> statement-breakpoint
ALTER TABLE "crm_pipelines" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "crm_tags" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"color" text DEFAULT 'slate' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crm_tags_name_check" CHECK (char_length("crm_tags"."name") between 1 and 50),
	CONSTRAINT "crm_tags_color_check" CHECK ("crm_tags"."color" ~ '^[a-z]{3,10}$')
);
--> statement-breakpoint
ALTER TABLE "crm_tags" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "crm_tasks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"due_at" timestamp with time zone,
	"priority" text DEFAULT 'normal' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"completed_at" timestamp with time zone,
	"assignee_user_id" uuid,
	"contact_id" uuid,
	"company_id" uuid,
	"deal_id" uuid,
	"created_by_user_id" uuid,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crm_tasks_title_check" CHECK (char_length("crm_tasks"."title") between 1 and 300),
	CONSTRAINT "crm_tasks_priority_check" CHECK ("crm_tasks"."priority" in ('low', 'normal', 'high')),
	CONSTRAINT "crm_tasks_status_check" CHECK ("crm_tasks"."status" in ('open', 'completed'))
);
--> statement-breakpoint
ALTER TABLE "crm_tasks" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE UNIQUE INDEX "crm_companies_id_org_unique" ON "crm_companies" USING btree ("id","organization_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "crm_companies_org_domain_unique" ON "crm_companies" USING btree ("organization_id","domain") WHERE "crm_companies"."domain" is not null and "crm_companies"."deleted_at" is null;
--> statement-breakpoint
CREATE UNIQUE INDEX "crm_contact_companies_one_primary" ON "crm_contact_companies" USING btree ("contact_id") WHERE "crm_contact_companies"."is_primary";
--> statement-breakpoint
CREATE UNIQUE INDEX "crm_contacts_id_org_unique" ON "crm_contacts" USING btree ("id","organization_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "crm_contacts_org_email_unique" ON "crm_contacts" USING btree ("organization_id","email") WHERE "crm_contacts"."email" is not null and "crm_contacts"."deleted_at" is null;
--> statement-breakpoint
CREATE UNIQUE INDEX "crm_custom_fields_org_entity_key_unique" ON "crm_custom_fields" USING btree ("organization_id","entity_type","key");
--> statement-breakpoint
CREATE UNIQUE INDEX "crm_deals_id_org_unique" ON "crm_deals" USING btree ("id","organization_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "crm_imports_id_org_unique" ON "crm_imports" USING btree ("id","organization_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "crm_pipeline_stages_id_org_unique" ON "crm_pipeline_stages" USING btree ("id","organization_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "crm_pipeline_stages_id_pipeline_unique" ON "crm_pipeline_stages" USING btree ("id","pipeline_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "crm_pipeline_stages_pipeline_name_unique" ON "crm_pipeline_stages" USING btree ("pipeline_id",lower("name"));
--> statement-breakpoint
CREATE UNIQUE INDEX "crm_pipelines_id_org_unique" ON "crm_pipelines" USING btree ("id","organization_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "crm_pipelines_org_name_unique" ON "crm_pipelines" USING btree ("organization_id",lower("name")) WHERE "crm_pipelines"."archived_at" is null;
--> statement-breakpoint
CREATE UNIQUE INDEX "crm_pipelines_one_default" ON "crm_pipelines" USING btree ("organization_id") WHERE "crm_pipelines"."is_default" and "crm_pipelines"."archived_at" is null;
--> statement-breakpoint
CREATE UNIQUE INDEX "crm_tags_id_org_unique" ON "crm_tags" USING btree ("id","organization_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "crm_tags_org_name_unique" ON "crm_tags" USING btree ("organization_id",lower("name"));
--> statement-breakpoint
ALTER TABLE "crm_companies" ADD CONSTRAINT "crm_companies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "crm_companies" ADD CONSTRAINT "crm_companies_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "crm_companies" ADD CONSTRAINT "crm_companies_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "crm_company_tags" ADD CONSTRAINT "crm_company_tags_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "crm_company_tags" ADD CONSTRAINT "crm_company_tags_tag_fk" FOREIGN KEY ("tag_id","organization_id") REFERENCES "public"."crm_tags"("id","organization_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "crm_company_tags" ADD CONSTRAINT "crm_company_tags_company_fk" FOREIGN KEY ("company_id","organization_id") REFERENCES "public"."crm_companies"("id","organization_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "crm_contact_companies" ADD CONSTRAINT "crm_contact_companies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "crm_contact_companies" ADD CONSTRAINT "crm_contact_companies_contact_fk" FOREIGN KEY ("contact_id","organization_id") REFERENCES "public"."crm_contacts"("id","organization_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "crm_contact_companies" ADD CONSTRAINT "crm_contact_companies_company_fk" FOREIGN KEY ("company_id","organization_id") REFERENCES "public"."crm_companies"("id","organization_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "crm_contact_tags" ADD CONSTRAINT "crm_contact_tags_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "crm_contact_tags" ADD CONSTRAINT "crm_contact_tags_tag_fk" FOREIGN KEY ("tag_id","organization_id") REFERENCES "public"."crm_tags"("id","organization_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "crm_contact_tags" ADD CONSTRAINT "crm_contact_tags_contact_fk" FOREIGN KEY ("contact_id","organization_id") REFERENCES "public"."crm_contacts"("id","organization_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "crm_contacts" ADD CONSTRAINT "crm_contacts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "crm_contacts" ADD CONSTRAINT "crm_contacts_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "crm_contacts" ADD CONSTRAINT "crm_contacts_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "crm_custom_fields" ADD CONSTRAINT "crm_custom_fields_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "crm_deal_tags" ADD CONSTRAINT "crm_deal_tags_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "crm_deal_tags" ADD CONSTRAINT "crm_deal_tags_tag_fk" FOREIGN KEY ("tag_id","organization_id") REFERENCES "public"."crm_tags"("id","organization_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "crm_deal_tags" ADD CONSTRAINT "crm_deal_tags_deal_fk" FOREIGN KEY ("deal_id","organization_id") REFERENCES "public"."crm_deals"("id","organization_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "crm_deals" ADD CONSTRAINT "crm_deals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "crm_deals" ADD CONSTRAINT "crm_deals_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "crm_deals" ADD CONSTRAINT "crm_deals_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "crm_deals" ADD CONSTRAINT "crm_deals_pipeline_fk" FOREIGN KEY ("pipeline_id","organization_id") REFERENCES "public"."crm_pipelines"("id","organization_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "crm_deals" ADD CONSTRAINT "crm_deals_stage_fk" FOREIGN KEY ("stage_id","pipeline_id") REFERENCES "public"."crm_pipeline_stages"("id","pipeline_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "crm_deals" ADD CONSTRAINT "crm_deals_contact_fk" FOREIGN KEY ("contact_id","organization_id") REFERENCES "public"."crm_contacts"("id","organization_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "crm_deals" ADD CONSTRAINT "crm_deals_company_fk" FOREIGN KEY ("company_id","organization_id") REFERENCES "public"."crm_companies"("id","organization_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "crm_exports" ADD CONSTRAINT "crm_exports_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "crm_exports" ADD CONSTRAINT "crm_exports_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "crm_import_rows" ADD CONSTRAINT "crm_import_rows_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "crm_import_rows" ADD CONSTRAINT "crm_import_rows_import_fk" FOREIGN KEY ("import_id","organization_id") REFERENCES "public"."crm_imports"("id","organization_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "crm_imports" ADD CONSTRAINT "crm_imports_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "crm_imports" ADD CONSTRAINT "crm_imports_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "crm_notes" ADD CONSTRAINT "crm_notes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "crm_notes" ADD CONSTRAINT "crm_notes_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "crm_notes" ADD CONSTRAINT "crm_notes_contact_fk" FOREIGN KEY ("contact_id","organization_id") REFERENCES "public"."crm_contacts"("id","organization_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "crm_notes" ADD CONSTRAINT "crm_notes_company_fk" FOREIGN KEY ("company_id","organization_id") REFERENCES "public"."crm_companies"("id","organization_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "crm_notes" ADD CONSTRAINT "crm_notes_deal_fk" FOREIGN KEY ("deal_id","organization_id") REFERENCES "public"."crm_deals"("id","organization_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "crm_pipeline_stages" ADD CONSTRAINT "crm_pipeline_stages_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "crm_pipeline_stages" ADD CONSTRAINT "crm_pipeline_stages_pipeline_fk" FOREIGN KEY ("pipeline_id","organization_id") REFERENCES "public"."crm_pipelines"("id","organization_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "crm_pipelines" ADD CONSTRAINT "crm_pipelines_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "crm_tags" ADD CONSTRAINT "crm_tags_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "crm_tasks" ADD CONSTRAINT "crm_tasks_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "crm_tasks" ADD CONSTRAINT "crm_tasks_assignee_user_id_users_id_fk" FOREIGN KEY ("assignee_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "crm_tasks" ADD CONSTRAINT "crm_tasks_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "crm_tasks" ADD CONSTRAINT "crm_tasks_contact_fk" FOREIGN KEY ("contact_id","organization_id") REFERENCES "public"."crm_contacts"("id","organization_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "crm_tasks" ADD CONSTRAINT "crm_tasks_company_fk" FOREIGN KEY ("company_id","organization_id") REFERENCES "public"."crm_companies"("id","organization_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "crm_tasks" ADD CONSTRAINT "crm_tasks_deal_fk" FOREIGN KEY ("deal_id","organization_id") REFERENCES "public"."crm_deals"("id","organization_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "crm_companies_org_created_idx" ON "crm_companies" USING btree ("organization_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);
--> statement-breakpoint
CREATE INDEX "crm_companies_org_name_idx" ON "crm_companies" USING btree ("organization_id",lower("name"),"id");
--> statement-breakpoint
CREATE INDEX "crm_companies_search_idx" ON "crm_companies" USING gin ("search_vector");
--> statement-breakpoint
CREATE INDEX "crm_companies_custom_fields_idx" ON "crm_companies" USING gin ("custom_fields" jsonb_path_ops);
--> statement-breakpoint
CREATE INDEX "crm_company_tags_tag_idx" ON "crm_company_tags" USING btree ("tag_id");
--> statement-breakpoint
CREATE INDEX "crm_contact_companies_company_idx" ON "crm_contact_companies" USING btree ("company_id");
--> statement-breakpoint
CREATE INDEX "crm_contact_tags_tag_idx" ON "crm_contact_tags" USING btree ("tag_id");
--> statement-breakpoint
CREATE INDEX "crm_contacts_org_created_idx" ON "crm_contacts" USING btree ("organization_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);
--> statement-breakpoint
CREATE INDEX "crm_contacts_org_name_idx" ON "crm_contacts" USING btree ("organization_id",lower(coalesce("first_name", '') || ' ' || coalesce("last_name", '')),"id");
--> statement-breakpoint
CREATE INDEX "crm_contacts_org_phone_idx" ON "crm_contacts" USING btree ("organization_id","phone");
--> statement-breakpoint
CREATE INDEX "crm_contacts_org_owner_idx" ON "crm_contacts" USING btree ("organization_id","owner_user_id");
--> statement-breakpoint
CREATE INDEX "crm_contacts_search_idx" ON "crm_contacts" USING gin ("search_vector");
--> statement-breakpoint
CREATE INDEX "crm_contacts_custom_fields_idx" ON "crm_contacts" USING gin ("custom_fields" jsonb_path_ops);
--> statement-breakpoint
CREATE INDEX "crm_custom_fields_org_entity_idx" ON "crm_custom_fields" USING btree ("organization_id","entity_type","position");
--> statement-breakpoint
CREATE INDEX "crm_deal_tags_tag_idx" ON "crm_deal_tags" USING btree ("tag_id");
--> statement-breakpoint
CREATE INDEX "crm_deals_org_created_idx" ON "crm_deals" USING btree ("organization_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);
--> statement-breakpoint
CREATE INDEX "crm_deals_board_idx" ON "crm_deals" USING btree ("pipeline_id","stage_id","position");
--> statement-breakpoint
CREATE INDEX "crm_deals_contact_idx" ON "crm_deals" USING btree ("contact_id");
--> statement-breakpoint
CREATE INDEX "crm_deals_company_idx" ON "crm_deals" USING btree ("company_id");
--> statement-breakpoint
CREATE INDEX "crm_deals_org_status_idx" ON "crm_deals" USING btree ("organization_id","status");
--> statement-breakpoint
CREATE INDEX "crm_deals_search_idx" ON "crm_deals" USING gin ("search_vector");
--> statement-breakpoint
CREATE INDEX "crm_deals_custom_fields_idx" ON "crm_deals" USING gin ("custom_fields" jsonb_path_ops);
--> statement-breakpoint
CREATE INDEX "crm_exports_org_created_idx" ON "crm_exports" USING btree ("organization_id","created_at" DESC NULLS LAST);
--> statement-breakpoint
CREATE INDEX "crm_exports_expires_idx" ON "crm_exports" USING btree ("expires_at");
--> statement-breakpoint
CREATE INDEX "crm_import_rows_status_idx" ON "crm_import_rows" USING btree ("import_id","status");
--> statement-breakpoint
CREATE INDEX "crm_imports_org_created_idx" ON "crm_imports" USING btree ("organization_id","created_at" DESC NULLS LAST);
--> statement-breakpoint
CREATE INDEX "crm_notes_contact_idx" ON "crm_notes" USING btree ("contact_id","created_at");
--> statement-breakpoint
CREATE INDEX "crm_notes_company_idx" ON "crm_notes" USING btree ("company_id","created_at");
--> statement-breakpoint
CREATE INDEX "crm_notes_deal_idx" ON "crm_notes" USING btree ("deal_id","created_at");
--> statement-breakpoint
CREATE INDEX "crm_pipeline_stages_pipeline_position_idx" ON "crm_pipeline_stages" USING btree ("pipeline_id","position");
--> statement-breakpoint
CREATE INDEX "crm_tasks_org_status_due_idx" ON "crm_tasks" USING btree ("organization_id","status","due_at");
--> statement-breakpoint
CREATE INDEX "crm_tasks_assignee_idx" ON "crm_tasks" USING btree ("organization_id","assignee_user_id","status");
--> statement-breakpoint
CREATE INDEX "crm_tasks_contact_idx" ON "crm_tasks" USING btree ("contact_id");
--> statement-breakpoint
CREATE INDEX "crm_tasks_deal_idx" ON "crm_tasks" USING btree ("deal_id");
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "crm_companies" AS PERMISSIVE FOR ALL TO public USING (app_is_system() OR organization_id = app_current_org()) WITH CHECK (app_is_system() OR organization_id = app_current_org());
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "crm_company_tags" AS PERMISSIVE FOR ALL TO public USING (app_is_system() OR organization_id = app_current_org()) WITH CHECK (app_is_system() OR organization_id = app_current_org());
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "crm_contact_companies" AS PERMISSIVE FOR ALL TO public USING (app_is_system() OR organization_id = app_current_org()) WITH CHECK (app_is_system() OR organization_id = app_current_org());
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "crm_contact_tags" AS PERMISSIVE FOR ALL TO public USING (app_is_system() OR organization_id = app_current_org()) WITH CHECK (app_is_system() OR organization_id = app_current_org());
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "crm_contacts" AS PERMISSIVE FOR ALL TO public USING (app_is_system() OR organization_id = app_current_org()) WITH CHECK (app_is_system() OR organization_id = app_current_org());
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "crm_custom_fields" AS PERMISSIVE FOR ALL TO public USING (app_is_system() OR organization_id = app_current_org()) WITH CHECK (app_is_system() OR organization_id = app_current_org());
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "crm_deal_tags" AS PERMISSIVE FOR ALL TO public USING (app_is_system() OR organization_id = app_current_org()) WITH CHECK (app_is_system() OR organization_id = app_current_org());
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "crm_deals" AS PERMISSIVE FOR ALL TO public USING (app_is_system() OR organization_id = app_current_org()) WITH CHECK (app_is_system() OR organization_id = app_current_org());
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "crm_exports" AS PERMISSIVE FOR ALL TO public USING (app_is_system() OR organization_id = app_current_org()) WITH CHECK (app_is_system() OR organization_id = app_current_org());
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "crm_import_rows" AS PERMISSIVE FOR ALL TO public USING (app_is_system() OR organization_id = app_current_org()) WITH CHECK (app_is_system() OR organization_id = app_current_org());
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "crm_imports" AS PERMISSIVE FOR ALL TO public USING (app_is_system() OR organization_id = app_current_org()) WITH CHECK (app_is_system() OR organization_id = app_current_org());
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "crm_notes" AS PERMISSIVE FOR ALL TO public USING (app_is_system() OR organization_id = app_current_org()) WITH CHECK (app_is_system() OR organization_id = app_current_org());
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "crm_pipeline_stages" AS PERMISSIVE FOR ALL TO public USING (app_is_system() OR organization_id = app_current_org()) WITH CHECK (app_is_system() OR organization_id = app_current_org());
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "crm_pipelines" AS PERMISSIVE FOR ALL TO public USING (app_is_system() OR organization_id = app_current_org()) WITH CHECK (app_is_system() OR organization_id = app_current_org());
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "crm_tags" AS PERMISSIVE FOR ALL TO public USING (app_is_system() OR organization_id = app_current_org()) WITH CHECK (app_is_system() OR organization_id = app_current_org());
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "crm_tasks" AS PERMISSIVE FOR ALL TO public USING (app_is_system() OR organization_id = app_current_org()) WITH CHECK (app_is_system() OR organization_id = app_current_org());
