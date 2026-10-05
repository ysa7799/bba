CREATE TABLE "automation_edges" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"from_key" text NOT NULL,
	"to_key" text NOT NULL,
	"branch" text NOT NULL,
	CONSTRAINT "automation_edges_branch_check" CHECK ("automation_edges"."branch" in ('next', 'true', 'false')),
	CONSTRAINT "automation_edges_no_self_loop" CHECK ("automation_edges"."from_key" <> "automation_edges"."to_key")
);
--> statement-breakpoint
ALTER TABLE "automation_edges" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "automation_nodes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"key" text NOT NULL,
	"type" text NOT NULL,
	"action" text,
	"label" text,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "automation_nodes_key_check" CHECK ("automation_nodes"."key" ~ '^[a-z0-9_-]{1,40}$'),
	CONSTRAINT "automation_nodes_type_check" CHECK ("automation_nodes"."type" in ('action', 'condition', 'wait'))
);
--> statement-breakpoint
ALTER TABLE "automation_nodes" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "automation_run_logs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"node_key" text,
	"level" text NOT NULL,
	"message" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_run_logs_level_check" CHECK ("automation_run_logs"."level" in ('info', 'warn', 'error'))
);
--> statement-breakpoint
ALTER TABLE "automation_run_logs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "automation_run_steps" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"node_key" text NOT NULL,
	"node_type" text NOT NULL,
	"action" text,
	"status" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"resume_at" timestamp with time zone,
	"output" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "automation_steps_status_check" CHECK ("automation_run_steps"."status" in ('running', 'waiting', 'succeeded', 'failed', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "automation_run_steps" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "automation_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"workflow_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"status" text NOT NULL,
	"trigger_type" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"source_event_id" uuid,
	"contact_id" uuid,
	"deal_id" uuid,
	"trigger_data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"depth" integer DEFAULT 0 NOT NULL,
	"parent_run_id" uuid,
	"current_node_key" text,
	"resume_at" timestamp with time zone,
	"deadline_at" timestamp with time zone NOT NULL,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "automation_runs_status_check" CHECK ("automation_runs"."status" in ('running', 'waiting', 'completed', 'failed', 'cancelled', 'skipped')),
	CONSTRAINT "automation_runs_depth_check" CHECK ("automation_runs"."depth" >= 0)
);
--> statement-breakpoint
ALTER TABLE "automation_runs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "automation_workflow_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"workflow_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"trigger_type" text NOT NULL,
	"trigger_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"entry_node_key" text,
	"published_at" timestamp with time zone,
	"published_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_versions_status_check" CHECK ("automation_workflow_versions"."status" in ('draft', 'published', 'retired'))
);
--> statement-breakpoint
ALTER TABLE "automation_workflow_versions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "automation_workflows" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"webhook_token_hash" text,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_workflows_name_check" CHECK (char_length("automation_workflows"."name") between 1 and 120),
	CONSTRAINT "automation_workflows_status_check" CHECK ("automation_workflows"."status" in ('draft', 'active', 'paused', 'archived'))
);
--> statement-breakpoint
ALTER TABLE "automation_workflows" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE UNIQUE INDEX "automation_edges_from_unique" ON "automation_edges" USING btree ("version_id","from_key","branch");
--> statement-breakpoint
CREATE UNIQUE INDEX "automation_edges_to_unique" ON "automation_edges" USING btree ("version_id","to_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "automation_nodes_version_key_unique" ON "automation_nodes" USING btree ("version_id","key");
--> statement-breakpoint
CREATE UNIQUE INDEX "automation_steps_run_node_unique" ON "automation_run_steps" USING btree ("run_id","node_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "automation_runs_id_org_unique" ON "automation_runs" USING btree ("id","organization_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "automation_runs_dedupe_unique" ON "automation_runs" USING btree ("workflow_id","dedupe_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "automation_versions_id_org_unique" ON "automation_workflow_versions" USING btree ("id","organization_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "automation_versions_number_unique" ON "automation_workflow_versions" USING btree ("workflow_id","number");
--> statement-breakpoint
CREATE UNIQUE INDEX "automation_versions_one_draft" ON "automation_workflow_versions" USING btree ("workflow_id") WHERE "automation_workflow_versions"."status" = 'draft';
--> statement-breakpoint
CREATE UNIQUE INDEX "automation_versions_one_published" ON "automation_workflow_versions" USING btree ("workflow_id") WHERE "automation_workflow_versions"."status" = 'published';
--> statement-breakpoint
CREATE UNIQUE INDEX "automation_workflows_id_org_unique" ON "automation_workflows" USING btree ("id","organization_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "automation_workflows_webhook_token_unique" ON "automation_workflows" USING btree ("webhook_token_hash");
--> statement-breakpoint
ALTER TABLE "automation_edges" ADD CONSTRAINT "automation_edges_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "automation_edges" ADD CONSTRAINT "automation_edges_version_fk" FOREIGN KEY ("version_id","organization_id") REFERENCES "public"."automation_workflow_versions"("id","organization_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "automation_nodes" ADD CONSTRAINT "automation_nodes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "automation_nodes" ADD CONSTRAINT "automation_nodes_version_fk" FOREIGN KEY ("version_id","organization_id") REFERENCES "public"."automation_workflow_versions"("id","organization_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "automation_run_logs" ADD CONSTRAINT "automation_run_logs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "automation_run_logs" ADD CONSTRAINT "automation_run_logs_run_fk" FOREIGN KEY ("run_id","organization_id") REFERENCES "public"."automation_runs"("id","organization_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "automation_run_steps" ADD CONSTRAINT "automation_run_steps_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "automation_run_steps" ADD CONSTRAINT "automation_steps_run_fk" FOREIGN KEY ("run_id","organization_id") REFERENCES "public"."automation_runs"("id","organization_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_workflow_fk" FOREIGN KEY ("workflow_id","organization_id") REFERENCES "public"."automation_workflows"("id","organization_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_version_fk" FOREIGN KEY ("version_id","organization_id") REFERENCES "public"."automation_workflow_versions"("id","organization_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_contact_fk" FOREIGN KEY ("contact_id","organization_id") REFERENCES "public"."crm_contacts"("id","organization_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_deal_fk" FOREIGN KEY ("deal_id","organization_id") REFERENCES "public"."crm_deals"("id","organization_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "automation_workflow_versions" ADD CONSTRAINT "automation_workflow_versions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "automation_workflow_versions" ADD CONSTRAINT "automation_workflow_versions_published_by_user_id_users_id_fk" FOREIGN KEY ("published_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "automation_workflow_versions" ADD CONSTRAINT "automation_versions_workflow_fk" FOREIGN KEY ("workflow_id","organization_id") REFERENCES "public"."automation_workflows"("id","organization_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "automation_workflows" ADD CONSTRAINT "automation_workflows_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "automation_workflows" ADD CONSTRAINT "automation_workflows_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "automation_run_logs_run_idx" ON "automation_run_logs" USING btree ("run_id","at");
--> statement-breakpoint
CREATE INDEX "automation_runs_workflow_idx" ON "automation_runs" USING btree ("workflow_id","started_at" DESC NULLS LAST,"id" DESC NULLS LAST);
--> statement-breakpoint
CREATE INDEX "automation_runs_due_idx" ON "automation_runs" USING btree ("resume_at") WHERE "automation_runs"."status" in ('running', 'waiting');
--> statement-breakpoint
CREATE INDEX "automation_runs_contact_idx" ON "automation_runs" USING btree ("workflow_id","contact_id","started_at");
--> statement-breakpoint
CREATE INDEX "automation_versions_trigger_idx" ON "automation_workflow_versions" USING btree ("organization_id","trigger_type","status");
--> statement-breakpoint
CREATE INDEX "automation_workflows_org_idx" ON "automation_workflows" USING btree ("organization_id","status");
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "automation_edges" AS PERMISSIVE FOR ALL TO public USING (app_is_system() OR organization_id = app_current_org()) WITH CHECK (app_is_system() OR organization_id = app_current_org());
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "automation_nodes" AS PERMISSIVE FOR ALL TO public USING (app_is_system() OR organization_id = app_current_org()) WITH CHECK (app_is_system() OR organization_id = app_current_org());
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "automation_run_logs" AS PERMISSIVE FOR ALL TO public USING (app_is_system() OR organization_id = app_current_org()) WITH CHECK (app_is_system() OR organization_id = app_current_org());
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "automation_run_steps" AS PERMISSIVE FOR ALL TO public USING (app_is_system() OR organization_id = app_current_org()) WITH CHECK (app_is_system() OR organization_id = app_current_org());
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "automation_runs" AS PERMISSIVE FOR ALL TO public USING (app_is_system() OR organization_id = app_current_org()) WITH CHECK (app_is_system() OR organization_id = app_current_org());
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "automation_workflow_versions" AS PERMISSIVE FOR ALL TO public USING (app_is_system() OR organization_id = app_current_org()) WITH CHECK (app_is_system() OR organization_id = app_current_org());
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "automation_workflows" AS PERMISSIVE FOR ALL TO public USING (app_is_system() OR organization_id = app_current_org()) WITH CHECK (app_is_system() OR organization_id = app_current_org());
