CREATE TABLE "integration_accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"status" text DEFAULT 'connecting' NOT NULL,
	"external_account_id" text NOT NULL,
	"account_label" text NOT NULL,
	"scopes" text[] NOT NULL,
	"tokens_sealed" text,
	"access_token_expires_at" timestamp with time zone,
	"connected_by_user_id" uuid,
	"last_refreshed_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"last_error" text,
	"last_error_at" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"disconnected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_accounts_provider_check" CHECK ("integration_accounts"."provider" ~ '^[a-z][a-z0-9_]{1,39}$'),
	CONSTRAINT "integration_accounts_status_check" CHECK ("integration_accounts"."status" in ('connecting', 'active', 'refresh_required', 'error', 'disconnected')),
	CONSTRAINT "integration_accounts_tokens_check" CHECK (("integration_accounts"."status" = 'disconnected' and "integration_accounts"."tokens_sealed" is null) or ("integration_accounts"."status" = 'connecting') or ("integration_accounts"."status" in ('active', 'refresh_required', 'error') and "integration_accounts"."tokens_sealed" is not null)),
	CONSTRAINT "integration_accounts_error_check" CHECK ("integration_accounts"."last_error" is null or char_length("integration_accounts"."last_error") <= 500),
	CONSTRAINT "integration_accounts_label_check" CHECK (char_length("integration_accounts"."account_label") between 1 and 320)
);
--> statement-breakpoint
ALTER TABLE "integration_accounts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "integration_oauth_states" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"purpose" text NOT NULL,
	"state_hash" text NOT NULL,
	"code_verifier_sealed" text NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_oauth_states_purpose_check" CHECK ("integration_oauth_states"."purpose" ~ '^[a-z_]{1,40}$')
);
--> statement-breakpoint
ALTER TABLE "integration_oauth_states" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "calendar_connections" ADD COLUMN "integration_account_id" uuid;
--> statement-breakpoint
CREATE UNIQUE INDEX "integration_accounts_id_org_unique" ON "integration_accounts" USING btree ("id","organization_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "integration_accounts_external_unique" ON "integration_accounts" USING btree ("organization_id","provider","external_account_id") WHERE "integration_accounts"."status" <> 'disconnected';
--> statement-breakpoint
CREATE UNIQUE INDEX "integration_oauth_states_hash_unique" ON "integration_oauth_states" USING btree ("state_hash");
--> statement-breakpoint
ALTER TABLE "integration_accounts" ADD CONSTRAINT "integration_accounts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "integration_accounts" ADD CONSTRAINT "integration_accounts_connected_by_user_id_users_id_fk" FOREIGN KEY ("connected_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "integration_oauth_states" ADD CONSTRAINT "integration_oauth_states_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "integration_oauth_states" ADD CONSTRAINT "integration_oauth_states_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "integration_accounts_org_idx" ON "integration_accounts" USING btree ("organization_id","created_at" DESC NULLS LAST);
--> statement-breakpoint
CREATE INDEX "integration_accounts_expiry_idx" ON "integration_accounts" USING btree ("access_token_expires_at") WHERE "integration_accounts"."status" in ('active', 'error');
--> statement-breakpoint
CREATE INDEX "integration_oauth_states_expiry_idx" ON "integration_oauth_states" USING btree ("expires_at");
--> statement-breakpoint
ALTER TABLE "calendar_connections" ADD CONSTRAINT "calendar_connections_integration_account_fk" FOREIGN KEY ("integration_account_id","organization_id") REFERENCES "public"."integration_accounts"("id","organization_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "calendar_connections_integration_account_idx" ON "calendar_connections" USING btree ("integration_account_id") WHERE "calendar_connections"."integration_account_id" is not null;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "integration_accounts" AS PERMISSIVE FOR ALL TO public USING (app_is_system() OR organization_id = app_current_org()) WITH CHECK (app_is_system() OR organization_id = app_current_org());
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "integration_oauth_states" AS PERMISSIVE FOR ALL TO public USING (app_is_system() OR organization_id = app_current_org()) WITH CHECK (app_is_system() OR organization_id = app_current_org());
