CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid,
	"actor_type" text NOT NULL,
	"actor_user_id" uuid,
	"actor_label" text,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip_address" "inet",
	"user_agent" text,
	"request_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_logs_action_format_check" CHECK ("audit_logs"."action" ~ '^[a-z_]+(\.[a-z_]+)+$'),
	CONSTRAINT "audit_logs_actor_type_check" CHECK ("audit_logs"."actor_type" in ('user', 'api_key', 'system', 'platform_admin'))
);
--> statement-breakpoint
ALTER TABLE "audit_logs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "job_failures" (
	"id" uuid PRIMARY KEY NOT NULL,
	"queue" text NOT NULL,
	"job_name" text NOT NULL,
	"job_id" text,
	"organization_id" uuid,
	"correlation_id" text,
	"attempts" integer NOT NULL,
	"error" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"failed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "job_failures" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid,
	"type" text NOT NULL,
	"version" integer NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"correlation_id" text,
	"causation_id" uuid,
	"payload" jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_until" timestamp with time zone,
	"dispatched_at" timestamp with time zone,
	"last_error" text,
	CONSTRAINT "outbox_events_type_format_check" CHECK ("outbox_events"."type" ~ '^[a-z_]+(\.[a-z_]+)+$'),
	CONSTRAINT "outbox_events_status_check" CHECK ("outbox_events"."status" in ('pending', 'processing', 'dispatched', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "outbox_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "processed_events" (
	"subscriber" text NOT NULL,
	"event_id" uuid NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "processed_events_subscriber_event_id_pk" PRIMARY KEY("subscriber","event_id")
);
--> statement-breakpoint
ALTER TABLE "processed_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_failures" ADD CONSTRAINT "job_failures_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_logs_org_created_idx" ON "audit_logs" USING btree ("organization_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_logs_actor_idx" ON "audit_logs" USING btree ("actor_user_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_org_action_idx" ON "audit_logs" USING btree ("organization_id","action","created_at");--> statement-breakpoint
CREATE INDEX "job_failures_failed_at_idx" ON "job_failures" USING btree ("failed_at");--> statement-breakpoint
CREATE INDEX "job_failures_org_idx" ON "job_failures" USING btree ("organization_id","failed_at");--> statement-breakpoint
CREATE INDEX "outbox_events_pending_idx" ON "outbox_events" USING btree ("available_at","id") WHERE "outbox_events"."status" in ('pending', 'processing');--> statement-breakpoint
CREATE INDEX "outbox_events_org_occurred_idx" ON "outbox_events" USING btree ("organization_id","occurred_at");--> statement-breakpoint
CREATE POLICY "audit_logs_select" ON "audit_logs" AS PERMISSIVE FOR SELECT TO public USING (app_is_system() OR "audit_logs"."organization_id" = app_current_org());--> statement-breakpoint
CREATE POLICY "audit_logs_insert" ON "audit_logs" AS PERMISSIVE FOR INSERT TO public WITH CHECK (app_is_system() OR "audit_logs"."organization_id" = app_current_org());--> statement-breakpoint
CREATE POLICY "job_failures_system" ON "job_failures" AS PERMISSIVE FOR ALL TO public USING (app_is_system()) WITH CHECK (app_is_system());--> statement-breakpoint
CREATE POLICY "outbox_events_insert" ON "outbox_events" AS PERMISSIVE FOR INSERT TO public WITH CHECK (app_is_system() OR "outbox_events"."organization_id" = app_current_org());--> statement-breakpoint
CREATE POLICY "outbox_events_system" ON "outbox_events" AS PERMISSIVE FOR ALL TO public USING (app_is_system()) WITH CHECK (app_is_system());--> statement-breakpoint
CREATE POLICY "processed_events_system" ON "processed_events" AS PERMISSIVE FOR ALL TO public USING (app_is_system()) WITH CHECK (app_is_system());