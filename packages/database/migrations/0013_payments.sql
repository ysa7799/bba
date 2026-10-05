CREATE TABLE "checkout_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"plan_version_id" uuid NOT NULL,
	"price_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"redirect_url" text,
	"expires_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "checkout_sessions_status_check" CHECK ("checkout_sessions"."status" in ('open', 'completed', 'failed', 'expired'))
);
--> statement-breakpoint
ALTER TABLE "checkout_sessions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "payment_webhook_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"signature_valid" boolean NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"provider_payment_id" text,
	"organization_id" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "payment_webhook_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"provider" text NOT NULL,
	"provider_payment_id" text,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"method" text,
	"refunded_amount_minor" bigint DEFAULT 0 NOT NULL,
	"failure_code" text,
	"failure_message" text,
	"captured_at" timestamp with time zone,
	"last_verified_at" timestamp with time zone,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_amount_check" CHECK ("payments"."amount_minor" > 0),
	CONSTRAINT "payments_currency_check" CHECK ("payments"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "payments_refund_bounds_check" CHECK ("payments"."refunded_amount_minor" >= 0 AND "payments"."refunded_amount_minor" <= "payments"."amount_minor"),
	CONSTRAINT "payments_status_check" CHECK ("payments"."status" in ('pending', 'requires_action', 'authorized', 'captured', 'failed', 'canceled', 'partially_refunded', 'refunded'))
);
--> statement-breakpoint
ALTER TABLE "payments" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE UNIQUE INDEX "checkout_sessions_payment_unique" ON "checkout_sessions" USING btree ("payment_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "payment_webhook_events_provider_event_unique" ON "payment_webhook_events" USING btree ("provider","provider_event_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "payments_id_org_unique" ON "payments" USING btree ("id","organization_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "payments_provider_ref_unique" ON "payments" USING btree ("provider","provider_payment_id") WHERE "payments"."provider_payment_id" is not null;
--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_plan_version_id_plan_versions_id_fk" FOREIGN KEY ("plan_version_id") REFERENCES "public"."plan_versions"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_price_id_prices_id_fk" FOREIGN KEY ("price_id") REFERENCES "public"."prices"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_payment_fk" FOREIGN KEY ("payment_id","organization_id") REFERENCES "public"."payments"("id","organization_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payment_webhook_events" ADD CONSTRAINT "payment_webhook_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "checkout_sessions_org_created_idx" ON "checkout_sessions" USING btree ("organization_id","created_at");
--> statement-breakpoint
CREATE INDEX "payment_webhook_events_received_idx" ON "payment_webhook_events" USING btree ("received_at");
--> statement-breakpoint
CREATE INDEX "payments_org_created_idx" ON "payments" USING btree ("organization_id","created_at");
--> statement-breakpoint
CREATE POLICY "tenant_read" ON "checkout_sessions" AS PERMISSIVE FOR SELECT TO public USING (app_is_system() OR organization_id = app_current_org());
--> statement-breakpoint
CREATE POLICY "system_write" ON "checkout_sessions" AS PERMISSIVE FOR ALL TO public USING (app_is_system()) WITH CHECK (app_is_system());
--> statement-breakpoint
CREATE POLICY "system_only" ON "payment_webhook_events" AS PERMISSIVE FOR ALL TO public USING (app_is_system()) WITH CHECK (app_is_system());
--> statement-breakpoint
CREATE POLICY "tenant_read" ON "payments" AS PERMISSIVE FOR SELECT TO public USING (app_is_system() OR organization_id = app_current_org());
--> statement-breakpoint
CREATE POLICY "system_write" ON "payments" AS PERMISSIVE FOR ALL TO public USING (app_is_system()) WITH CHECK (app_is_system());
