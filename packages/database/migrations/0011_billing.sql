CREATE TABLE "billing_customers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"legal_name" text NOT NULL,
	"billing_email" text NOT NULL,
	"tax_id" text,
	"country_code" char(2) NOT NULL,
	"address_line1" text,
	"address_line2" text,
	"city" text,
	"postal_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_customers_email_check" CHECK ("billing_customers"."billing_email" = lower(btrim("billing_customers"."billing_email")))
);
--> statement-breakpoint
ALTER TABLE "billing_customers" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "billing_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid,
	"type" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "billing_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "entitlement_overrides" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"reason" text NOT NULL,
	"expires_at" timestamp with time zone,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entitlement_overrides_reason_check" CHECK (char_length("entitlement_overrides"."reason") between 3 and 500)
);
--> statement-breakpoint
ALTER TABLE "entitlement_overrides" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "plan_entitlements" (
	"plan_version_id" uuid NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	CONSTRAINT "plan_entitlements_plan_version_id_key_pk" PRIMARY KEY("plan_version_id","key")
);
--> statement-breakpoint
ALTER TABLE "plan_entitlements" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "plan_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"plan_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plan_versions_status_check" CHECK ("plan_versions"."status" in ('draft', 'published', 'retired')),
	CONSTRAINT "plan_versions_version_check" CHECK ("plan_versions"."version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "plan_versions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" uuid PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"is_public" boolean DEFAULT true NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plans_key_format_check" CHECK ("plans"."key" ~ '^[a-z0-9][a-z0-9_-]{1,62}$'),
	CONSTRAINT "plans_status_check" CHECK ("plans"."status" in ('active', 'archived'))
);
--> statement-breakpoint
ALTER TABLE "plans" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "prices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"plan_version_id" uuid NOT NULL,
	"currency" char(3) NOT NULL,
	"interval" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prices_amount_check" CHECK ("prices"."amount_minor" >= 0),
	CONSTRAINT "prices_currency_check" CHECK ("prices"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "prices_interval_check" CHECK ("prices"."interval" in ('month', 'year'))
);
--> statement-breakpoint
ALTER TABLE "prices" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "subscription_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"price_id" uuid NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscription_items_quantity_check" CHECK ("subscription_items"."quantity" >= 1)
);
--> statement-breakpoint
ALTER TABLE "subscription_items" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"plan_version_id" uuid NOT NULL,
	"status" text NOT NULL,
	"provider" text DEFAULT 'manual' NOT NULL,
	"provider_subscription_id" text,
	"current_period_start" timestamp with time zone NOT NULL,
	"current_period_end" timestamp with time zone,
	"trial_ends_at" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"canceled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscriptions_status_check" CHECK ("subscriptions"."status" in ('trialing', 'active', 'past_due', 'paused', 'canceled', 'incomplete'))
);
--> statement-breakpoint
ALTER TABLE "subscriptions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "usage_counters" (
	"organization_id" uuid NOT NULL,
	"metric" text NOT NULL,
	"period_start" date NOT NULL,
	"used" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_counters_organization_id_metric_period_start_pk" PRIMARY KEY("organization_id","metric","period_start"),
	CONSTRAINT "usage_counters_used_check" CHECK ("usage_counters"."used" >= 0)
);
--> statement-breakpoint
ALTER TABLE "usage_counters" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "usage_records" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"metric" text NOT NULL,
	"period_start" date NOT NULL,
	"quantity" bigint NOT NULL,
	"idempotency_key" text,
	"source" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_records_quantity_check" CHECK ("usage_records"."quantity" > 0)
);
--> statement-breakpoint
ALTER TABLE "usage_records" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE UNIQUE INDEX "billing_customers_org_unique" ON "billing_customers" USING btree ("organization_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "entitlement_overrides_org_key_unique" ON "entitlement_overrides" USING btree ("organization_id","key");
--> statement-breakpoint
CREATE UNIQUE INDEX "plan_versions_plan_version_unique" ON "plan_versions" USING btree ("plan_id","version");
--> statement-breakpoint
CREATE UNIQUE INDEX "plans_key_unique" ON "plans" USING btree ("key");
--> statement-breakpoint
CREATE UNIQUE INDEX "plans_single_default" ON "plans" USING btree ("is_default") WHERE "plans"."is_default";
--> statement-breakpoint
CREATE UNIQUE INDEX "prices_version_currency_interval_unique" ON "prices" USING btree ("plan_version_id","currency","interval") WHERE "prices"."status" = 'active';
--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_one_live_per_org" ON "subscriptions" USING btree ("organization_id") WHERE "subscriptions"."status" <> 'canceled';
--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_id_org_unique" ON "subscriptions" USING btree ("id","organization_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_provider_ref_unique" ON "subscriptions" USING btree ("provider","provider_subscription_id") WHERE "subscriptions"."provider_subscription_id" is not null;
--> statement-breakpoint
CREATE UNIQUE INDEX "usage_records_idempotency_unique" ON "usage_records" USING btree ("organization_id","idempotency_key") WHERE "usage_records"."idempotency_key" is not null;
--> statement-breakpoint
ALTER TABLE "billing_customers" ADD CONSTRAINT "billing_customers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "billing_events" ADD CONSTRAINT "billing_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "entitlement_overrides" ADD CONSTRAINT "entitlement_overrides_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "entitlement_overrides" ADD CONSTRAINT "entitlement_overrides_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "plan_entitlements" ADD CONSTRAINT "plan_entitlements_plan_version_id_plan_versions_id_fk" FOREIGN KEY ("plan_version_id") REFERENCES "public"."plan_versions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "plan_versions" ADD CONSTRAINT "plan_versions_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "prices" ADD CONSTRAINT "prices_plan_version_id_plan_versions_id_fk" FOREIGN KEY ("plan_version_id") REFERENCES "public"."plan_versions"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "subscription_items" ADD CONSTRAINT "subscription_items_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "subscription_items" ADD CONSTRAINT "subscription_items_price_id_prices_id_fk" FOREIGN KEY ("price_id") REFERENCES "public"."prices"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "subscription_items" ADD CONSTRAINT "subscription_items_subscription_fk" FOREIGN KEY ("subscription_id","organization_id") REFERENCES "public"."subscriptions"("id","organization_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_version_id_plan_versions_id_fk" FOREIGN KEY ("plan_version_id") REFERENCES "public"."plan_versions"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "usage_counters" ADD CONSTRAINT "usage_counters_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "billing_events_org_idx" ON "billing_events" USING btree ("organization_id","occurred_at");
--> statement-breakpoint
CREATE INDEX "subscription_items_subscription_idx" ON "subscription_items" USING btree ("subscription_id");
--> statement-breakpoint
CREATE INDEX "usage_records_org_metric_period_idx" ON "usage_records" USING btree ("organization_id","metric","period_start");
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "billing_customers" AS PERMISSIVE FOR ALL TO public USING (app_is_system() OR organization_id = app_current_org()) WITH CHECK (app_is_system() OR organization_id = app_current_org());
--> statement-breakpoint
CREATE POLICY "tenant_read" ON "billing_events" AS PERMISSIVE FOR SELECT TO public USING (app_is_system() OR organization_id = app_current_org());
--> statement-breakpoint
CREATE POLICY "system_write" ON "billing_events" AS PERMISSIVE FOR ALL TO public USING (app_is_system()) WITH CHECK (app_is_system());
--> statement-breakpoint
CREATE POLICY "tenant_read" ON "entitlement_overrides" AS PERMISSIVE FOR SELECT TO public USING (app_is_system() OR organization_id = app_current_org());
--> statement-breakpoint
CREATE POLICY "system_write" ON "entitlement_overrides" AS PERMISSIVE FOR ALL TO public USING (app_is_system()) WITH CHECK (app_is_system());
--> statement-breakpoint
CREATE POLICY "catalog_read" ON "plan_entitlements" AS PERMISSIVE FOR SELECT TO public USING (true);
--> statement-breakpoint
CREATE POLICY "catalog_write" ON "plan_entitlements" AS PERMISSIVE FOR ALL TO public USING (app_is_system()) WITH CHECK (app_is_system());
--> statement-breakpoint
CREATE POLICY "catalog_read" ON "plan_versions" AS PERMISSIVE FOR SELECT TO public USING (true);
--> statement-breakpoint
CREATE POLICY "catalog_write" ON "plan_versions" AS PERMISSIVE FOR ALL TO public USING (app_is_system()) WITH CHECK (app_is_system());
--> statement-breakpoint
CREATE POLICY "catalog_read" ON "plans" AS PERMISSIVE FOR SELECT TO public USING (true);
--> statement-breakpoint
CREATE POLICY "catalog_write" ON "plans" AS PERMISSIVE FOR ALL TO public USING (app_is_system()) WITH CHECK (app_is_system());
--> statement-breakpoint
CREATE POLICY "catalog_read" ON "prices" AS PERMISSIVE FOR SELECT TO public USING (true);
--> statement-breakpoint
CREATE POLICY "catalog_write" ON "prices" AS PERMISSIVE FOR ALL TO public USING (app_is_system()) WITH CHECK (app_is_system());
--> statement-breakpoint
CREATE POLICY "tenant_read" ON "subscription_items" AS PERMISSIVE FOR SELECT TO public USING (app_is_system() OR organization_id = app_current_org());
--> statement-breakpoint
CREATE POLICY "system_write" ON "subscription_items" AS PERMISSIVE FOR ALL TO public USING (app_is_system()) WITH CHECK (app_is_system());
--> statement-breakpoint
CREATE POLICY "tenant_read" ON "subscriptions" AS PERMISSIVE FOR SELECT TO public USING (app_is_system() OR organization_id = app_current_org());
--> statement-breakpoint
CREATE POLICY "system_write" ON "subscriptions" AS PERMISSIVE FOR ALL TO public USING (app_is_system()) WITH CHECK (app_is_system());
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "usage_counters" AS PERMISSIVE FOR ALL TO public USING (app_is_system() OR organization_id = app_current_org()) WITH CHECK (app_is_system() OR organization_id = app_current_org());
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "usage_records" AS PERMISSIVE FOR ALL TO public USING (app_is_system() OR organization_id = app_current_org()) WITH CHECK (app_is_system() OR organization_id = app_current_org());
