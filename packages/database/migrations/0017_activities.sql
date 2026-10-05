CREATE TABLE "activities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"type" text NOT NULL,
	"category" text NOT NULL,
	"channel" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_type" text NOT NULL,
	"actor_user_id" uuid,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"contact_id" uuid,
	"company_id" uuid,
	"deal_id" uuid,
	"required_permission" text NOT NULL,
	"summary" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_event_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "activities_type_check" CHECK ("activities"."type" ~ '^[a-z_]+\.[a-z_]+$'),
	CONSTRAINT "activities_summary_check" CHECK (char_length("activities"."summary") between 1 and 1000),
	CONSTRAINT "activities_actor_type_check" CHECK ("activities"."actor_type" in ('user', 'system', 'api_key', 'workflow', 'contact'))
);
--> statement-breakpoint
ALTER TABLE "activities" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE UNIQUE INDEX "activities_source_event_unique" ON "activities" USING btree ("source_event_id");
--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_contact_fk" FOREIGN KEY ("contact_id","organization_id") REFERENCES "public"."crm_contacts"("id","organization_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_company_fk" FOREIGN KEY ("company_id","organization_id") REFERENCES "public"."crm_companies"("id","organization_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_deal_fk" FOREIGN KEY ("deal_id","organization_id") REFERENCES "public"."crm_deals"("id","organization_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "activities_org_time_idx" ON "activities" USING btree ("organization_id","occurred_at" DESC NULLS LAST,"id" DESC NULLS LAST);
--> statement-breakpoint
CREATE INDEX "activities_contact_time_idx" ON "activities" USING btree ("contact_id","occurred_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "activities"."contact_id" is not null;
--> statement-breakpoint
CREATE INDEX "activities_company_time_idx" ON "activities" USING btree ("company_id","occurred_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "activities"."company_id" is not null;
--> statement-breakpoint
CREATE INDEX "activities_deal_time_idx" ON "activities" USING btree ("deal_id","occurred_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "activities"."deal_id" is not null;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "activities" AS PERMISSIVE FOR ALL TO public USING (app_is_system() OR organization_id = app_current_org()) WITH CHECK (app_is_system() OR organization_id = app_current_org());
