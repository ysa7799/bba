CREATE TABLE "api_idempotency_keys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"api_key_id" uuid NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"status" text DEFAULT 'processing' NOT NULL,
	"response_status" integer,
	"response_body" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_idempotency_keys_key_check" CHECK (char_length("api_idempotency_keys"."key") between 1 and 255),
	CONSTRAINT "api_idempotency_keys_status_check" CHECK ("api_idempotency_keys"."status" in ('processing', 'completed'))
);
--> statement-breakpoint
ALTER TABLE "api_idempotency_keys" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"scopes" text[] NOT NULL,
	"created_by_user_id" uuid,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_keys_name_check" CHECK (char_length("api_keys"."name") between 1 and 100),
	CONSTRAINT "api_keys_scopes_check" CHECK (cardinality("api_keys"."scopes") between 1 and 60)
);
--> statement-breakpoint
ALTER TABLE "api_keys" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"body" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"last_attempt_at" timestamp with time zone,
	"response_status" integer,
	"last_error" text,
	"duration_ms" integer,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_deliveries_status_check" CHECK ("webhook_deliveries"."status" in ('pending', 'succeeded', 'failed')),
	CONSTRAINT "webhook_deliveries_attempts_check" CHECK ("webhook_deliveries"."attempts" >= 0),
	CONSTRAINT "webhook_deliveries_error_check" CHECK ("webhook_deliveries"."last_error" is null or char_length("webhook_deliveries"."last_error") <= 500),
	CONSTRAINT "webhook_deliveries_body_check" CHECK (char_length("webhook_deliveries"."body") <= 65536)
);
--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "webhook_endpoints" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"url" text NOT NULL,
	"description" text,
	"events" text[] NOT NULL,
	"secret_sealed" text NOT NULL,
	"previous_secret_sealed" text,
	"previous_secret_expires_at" timestamp with time zone,
	"status" text DEFAULT 'active' NOT NULL,
	"disabled_reason" text,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_endpoints_url_check" CHECK (char_length("webhook_endpoints"."url") between 8 and 2000),
	CONSTRAINT "webhook_endpoints_description_check" CHECK ("webhook_endpoints"."description" is null or char_length("webhook_endpoints"."description") <= 500),
	CONSTRAINT "webhook_endpoints_events_check" CHECK (cardinality("webhook_endpoints"."events") between 1 and 100),
	CONSTRAINT "webhook_endpoints_status_check" CHECK ("webhook_endpoints"."status" in ('active', 'disabled')),
	CONSTRAINT "webhook_endpoints_disabled_check" CHECK (("webhook_endpoints"."status" = 'disabled') = ("webhook_endpoints"."disabled_reason" is not null) and ("webhook_endpoints"."disabled_reason" is null or "webhook_endpoints"."disabled_reason" in ('manual', 'failing'))),
	CONSTRAINT "webhook_endpoints_failures_check" CHECK ("webhook_endpoints"."consecutive_failures" >= 0)
);
--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE UNIQUE INDEX "api_idempotency_keys_unique" ON "api_idempotency_keys" USING btree ("api_key_id","key");
--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_id_org_unique" ON "api_keys" USING btree ("id","organization_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_hash_unique" ON "api_keys" USING btree ("key_hash");
--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_deliveries_event_unique" ON "webhook_deliveries" USING btree ("endpoint_id","event_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_endpoints_id_org_unique" ON "webhook_endpoints" USING btree ("id","organization_id");
--> statement-breakpoint
ALTER TABLE "api_idempotency_keys" ADD CONSTRAINT "api_idempotency_keys_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "api_idempotency_keys" ADD CONSTRAINT "api_idempotency_keys_api_key_fk" FOREIGN KEY ("api_key_id","organization_id") REFERENCES "public"."api_keys"("id","organization_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_revoked_by_user_id_users_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_endpoint_fk" FOREIGN KEY ("endpoint_id","organization_id") REFERENCES "public"."webhook_endpoints"("id","organization_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "api_idempotency_keys_created_idx" ON "api_idempotency_keys" USING btree ("created_at");
--> statement-breakpoint
CREATE INDEX "api_keys_org_idx" ON "api_keys" USING btree ("organization_id","created_at" DESC NULLS LAST);
--> statement-breakpoint
CREATE INDEX "webhook_deliveries_endpoint_idx" ON "webhook_deliveries" USING btree ("organization_id","endpoint_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);
--> statement-breakpoint
CREATE INDEX "webhook_deliveries_due_idx" ON "webhook_deliveries" USING btree ("next_attempt_at") WHERE "webhook_deliveries"."status" = 'pending';
--> statement-breakpoint
CREATE INDEX "webhook_deliveries_created_idx" ON "webhook_deliveries" USING btree ("created_at");
--> statement-breakpoint
CREATE INDEX "webhook_endpoints_org_idx" ON "webhook_endpoints" USING btree ("organization_id","created_at" DESC NULLS LAST);
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "api_idempotency_keys" AS PERMISSIVE FOR ALL TO public USING (app_is_system() OR organization_id = app_current_org()) WITH CHECK (app_is_system() OR organization_id = app_current_org());
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "api_keys" AS PERMISSIVE FOR ALL TO public USING (app_is_system() OR organization_id = app_current_org()) WITH CHECK (app_is_system() OR organization_id = app_current_org());
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "webhook_deliveries" AS PERMISSIVE FOR ALL TO public USING (app_is_system() OR organization_id = app_current_org()) WITH CHECK (app_is_system() OR organization_id = app_current_org());
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "webhook_endpoints" AS PERMISSIVE FOR ALL TO public USING (app_is_system() OR organization_id = app_current_org()) WITH CHECK (app_is_system() OR organization_id = app_current_org());
