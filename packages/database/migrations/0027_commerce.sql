CREATE TABLE "commerce_checkouts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"redirect_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "commerce_checkouts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "commerce_invoice_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"product_id" uuid,
	"description" text NOT NULL,
	"quantity" numeric(12, 3) NOT NULL,
	"unit_amount_minor" bigint NOT NULL,
	"discount_bp" integer DEFAULT 0 NOT NULL,
	"tax_rate_id" uuid,
	"tax_name" text,
	"tax_rate_bp" integer DEFAULT 0 NOT NULL,
	"subtotal_minor" bigint NOT NULL,
	"discount_minor" bigint NOT NULL,
	"tax_minor" bigint NOT NULL,
	"total_minor" bigint NOT NULL,
	"invoice_id" uuid NOT NULL,
	CONSTRAINT "commerce_invoice_items_quantity_check" CHECK ("commerce_invoice_items"."quantity" > 0),
	CONSTRAINT "commerce_invoice_items_unit_check" CHECK ("commerce_invoice_items"."unit_amount_minor" >= 0),
	CONSTRAINT "commerce_invoice_items_discount_check" CHECK ("commerce_invoice_items"."discount_bp" between 0 and 10000),
	CONSTRAINT "commerce_invoice_items_tax_check" CHECK ("commerce_invoice_items"."tax_rate_bp" between 0 and 10000),
	CONSTRAINT "commerce_invoice_items_total_check" CHECK ("commerce_invoice_items"."total_minor" >= 0)
);
--> statement-breakpoint
ALTER TABLE "commerce_invoice_items" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "commerce_invoice_payments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"source" text NOT NULL,
	"payment_id" uuid,
	"method" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"refunded_minor" bigint DEFAULT 0 NOT NULL,
	"reference" text,
	"note" text,
	"received_at" timestamp with time zone NOT NULL,
	"recorded_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_invoice_payments_amount_check" CHECK ("commerce_invoice_payments"."amount_minor" > 0),
	CONSTRAINT "commerce_invoice_payments_refund_check" CHECK ("commerce_invoice_payments"."refunded_minor" >= 0 and "commerce_invoice_payments"."refunded_minor" <= "commerce_invoice_payments"."amount_minor"),
	CONSTRAINT "commerce_invoice_payments_source_check" CHECK (("commerce_invoice_payments"."source" = 'online') = ("commerce_invoice_payments"."payment_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "commerce_invoice_payments" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "commerce_invoices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"company_id" uuid,
	"deal_id" uuid,
	"currency" char(3) NOT NULL,
	"notes" text,
	"terms" text,
	"subtotal_minor" bigint DEFAULT 0 NOT NULL,
	"discount_minor" bigint DEFAULT 0 NOT NULL,
	"tax_minor" bigint DEFAULT 0 NOT NULL,
	"total_minor" bigint DEFAULT 0 NOT NULL,
	"public_token_hash" text,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"number" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"quote_id" uuid,
	"issue_date" date,
	"due_date" date,
	"amount_paid_minor" bigint DEFAULT 0 NOT NULL,
	"amount_refunded_minor" bigint DEFAULT 0 NOT NULL,
	"sent_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	"overdue_at" timestamp with time zone,
	CONSTRAINT "commerce_invoices_amounts_check" CHECK ("commerce_invoices"."subtotal_minor" >= 0 and "commerce_invoices"."discount_minor" >= 0 and "commerce_invoices"."tax_minor" >= 0 and "commerce_invoices"."total_minor" >= 0),
	CONSTRAINT "commerce_invoices_currency_check" CHECK ("commerce_invoices"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "commerce_invoices_status_check" CHECK ("commerce_invoices"."status" in ('draft', 'open', 'paid', 'void')),
	CONSTRAINT "commerce_invoices_paid_check" CHECK ("commerce_invoices"."amount_paid_minor" >= 0 and "commerce_invoices"."amount_refunded_minor" >= 0),
	CONSTRAINT "commerce_invoices_issued_check" CHECK ("commerce_invoices"."status" = 'draft' or ("commerce_invoices"."number" is not null and "commerce_invoices"."issue_date" is not null))
);
--> statement-breakpoint
ALTER TABLE "commerce_invoices" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "commerce_payment_connections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"name" text NOT NULL,
	"status" text NOT NULL,
	"credentials_ciphertext" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_connections_status_check" CHECK ("commerce_payment_connections"."status" in ('configuration_required', 'active', 'disconnected'))
);
--> statement-breakpoint
ALTER TABLE "commerce_payment_connections" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "commerce_product_prices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"currency" char(3) NOT NULL,
	"unit_amount_minor" bigint NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_prices_amount_check" CHECK ("commerce_product_prices"."unit_amount_minor" >= 0),
	CONSTRAINT "commerce_prices_currency_check" CHECK ("commerce_product_prices"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
ALTER TABLE "commerce_product_prices" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "commerce_products" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"sku" text,
	"kind" text DEFAULT 'service' NOT NULL,
	"tax_rate_id" uuid,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_products_name_check" CHECK (char_length("commerce_products"."name") between 1 and 200),
	CONSTRAINT "commerce_products_kind_check" CHECK ("commerce_products"."kind" in ('product', 'service'))
);
--> statement-breakpoint
ALTER TABLE "commerce_products" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "commerce_quote_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"product_id" uuid,
	"description" text NOT NULL,
	"quantity" numeric(12, 3) NOT NULL,
	"unit_amount_minor" bigint NOT NULL,
	"discount_bp" integer DEFAULT 0 NOT NULL,
	"tax_rate_id" uuid,
	"tax_name" text,
	"tax_rate_bp" integer DEFAULT 0 NOT NULL,
	"subtotal_minor" bigint NOT NULL,
	"discount_minor" bigint NOT NULL,
	"tax_minor" bigint NOT NULL,
	"total_minor" bigint NOT NULL,
	"quote_id" uuid NOT NULL,
	CONSTRAINT "commerce_quote_items_quantity_check" CHECK ("commerce_quote_items"."quantity" > 0),
	CONSTRAINT "commerce_quote_items_unit_check" CHECK ("commerce_quote_items"."unit_amount_minor" >= 0),
	CONSTRAINT "commerce_quote_items_discount_check" CHECK ("commerce_quote_items"."discount_bp" between 0 and 10000),
	CONSTRAINT "commerce_quote_items_tax_check" CHECK ("commerce_quote_items"."tax_rate_bp" between 0 and 10000),
	CONSTRAINT "commerce_quote_items_total_check" CHECK ("commerce_quote_items"."total_minor" >= 0)
);
--> statement-breakpoint
ALTER TABLE "commerce_quote_items" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "commerce_quotes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"company_id" uuid,
	"deal_id" uuid,
	"currency" char(3) NOT NULL,
	"notes" text,
	"terms" text,
	"subtotal_minor" bigint DEFAULT 0 NOT NULL,
	"discount_minor" bigint DEFAULT 0 NOT NULL,
	"tax_minor" bigint DEFAULT 0 NOT NULL,
	"total_minor" bigint DEFAULT 0 NOT NULL,
	"public_token_hash" text,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"number" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"issue_date" date NOT NULL,
	"valid_until" date,
	"sent_at" timestamp with time zone,
	"responded_at" timestamp with time zone,
	"converted_invoice_id" uuid,
	CONSTRAINT "commerce_quotes_amounts_check" CHECK ("commerce_quotes"."subtotal_minor" >= 0 and "commerce_quotes"."discount_minor" >= 0 and "commerce_quotes"."tax_minor" >= 0 and "commerce_quotes"."total_minor" >= 0),
	CONSTRAINT "commerce_quotes_currency_check" CHECK ("commerce_quotes"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "commerce_quotes_status_check" CHECK ("commerce_quotes"."status" in ('draft', 'sent', 'accepted', 'declined', 'expired', 'converted'))
);
--> statement-breakpoint
ALTER TABLE "commerce_quotes" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "commerce_refunds" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"invoice_payment_id" uuid NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"reason" text NOT NULL,
	"status" text NOT NULL,
	"provider_refund_id" text,
	"failure_message" text,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "commerce_refunds_amount_check" CHECK ("commerce_refunds"."amount_minor" > 0),
	CONSTRAINT "commerce_refunds_status_check" CHECK ("commerce_refunds"."status" in ('pending', 'succeeded', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "commerce_refunds" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "commerce_settings" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"invoice_prefix" text DEFAULT 'INV-' NOT NULL,
	"next_invoice_number" bigint DEFAULT 1 NOT NULL,
	"quote_prefix" text DEFAULT 'QUO-' NOT NULL,
	"next_quote_number" bigint DEFAULT 1 NOT NULL,
	"default_due_days" integer DEFAULT 14 NOT NULL,
	"invoice_footer" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_settings_prefix_check" CHECK (char_length("commerce_settings"."invoice_prefix") <= 20 and char_length("commerce_settings"."quote_prefix") <= 20),
	CONSTRAINT "commerce_settings_next_check" CHECK ("commerce_settings"."next_invoice_number" >= 1 and "commerce_settings"."next_quote_number" >= 1),
	CONSTRAINT "commerce_settings_due_check" CHECK ("commerce_settings"."default_due_days" between 0 and 365)
);
--> statement-breakpoint
ALTER TABLE "commerce_settings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "commerce_tax_rates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"rate_bp" integer NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_tax_rates_rate_check" CHECK ("commerce_tax_rates"."rate_bp" between 0 and 10000),
	CONSTRAINT "commerce_tax_rates_name_check" CHECK (char_length("commerce_tax_rates"."name") between 1 and 60)
);
--> statement-breakpoint
ALTER TABLE "commerce_tax_rates" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_checkouts_payment_unique" ON "commerce_checkouts" USING btree ("payment_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_invoice_payments_id_org_unique" ON "commerce_invoice_payments" USING btree ("id","organization_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_invoice_payments_payment_unique" ON "commerce_invoice_payments" USING btree ("payment_id") WHERE "commerce_invoice_payments"."payment_id" is not null;
--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_invoices_id_org_unique" ON "commerce_invoices" USING btree ("id","organization_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_invoices_number_unique" ON "commerce_invoices" USING btree ("organization_id","number") WHERE "commerce_invoices"."number" is not null;
--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_invoices_token_unique" ON "commerce_invoices" USING btree ("public_token_hash");
--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_connections_id_org_unique" ON "commerce_payment_connections" USING btree ("id","organization_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_connections_one_live" ON "commerce_payment_connections" USING btree ("organization_id") WHERE "commerce_payment_connections"."status" <> 'disconnected';
--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_prices_id_org_unique" ON "commerce_product_prices" USING btree ("id","organization_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_prices_live_unique" ON "commerce_product_prices" USING btree ("product_id","currency") WHERE "commerce_product_prices"."archived_at" is null;
--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_products_id_org_unique" ON "commerce_products" USING btree ("id","organization_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_products_sku_unique" ON "commerce_products" USING btree ("organization_id",lower("sku")) WHERE "commerce_products"."sku" is not null;
--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_quotes_id_org_unique" ON "commerce_quotes" USING btree ("id","organization_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_quotes_number_unique" ON "commerce_quotes" USING btree ("organization_id","number");
--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_quotes_token_unique" ON "commerce_quotes" USING btree ("public_token_hash");
--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_tax_rates_id_org_unique" ON "commerce_tax_rates" USING btree ("id","organization_id");
--> statement-breakpoint
ALTER TABLE "commerce_checkouts" ADD CONSTRAINT "commerce_checkouts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "commerce_checkouts" ADD CONSTRAINT "commerce_checkouts_invoice_fk" FOREIGN KEY ("invoice_id","organization_id") REFERENCES "public"."commerce_invoices"("id","organization_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "commerce_checkouts" ADD CONSTRAINT "commerce_checkouts_payment_fk" FOREIGN KEY ("payment_id","organization_id") REFERENCES "public"."payments"("id","organization_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "commerce_checkouts" ADD CONSTRAINT "commerce_checkouts_connection_fk" FOREIGN KEY ("connection_id","organization_id") REFERENCES "public"."commerce_payment_connections"("id","organization_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "commerce_invoice_items" ADD CONSTRAINT "commerce_invoice_items_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "commerce_invoice_items" ADD CONSTRAINT "commerce_invoice_items_invoice_fk" FOREIGN KEY ("invoice_id","organization_id") REFERENCES "public"."commerce_invoices"("id","organization_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "commerce_invoice_items" ADD CONSTRAINT "commerce_invoice_items_product_fk" FOREIGN KEY ("product_id","organization_id") REFERENCES "public"."commerce_products"("id","organization_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "commerce_invoice_payments" ADD CONSTRAINT "commerce_invoice_payments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "commerce_invoice_payments" ADD CONSTRAINT "commerce_invoice_payments_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "commerce_invoice_payments" ADD CONSTRAINT "commerce_invoice_payments_invoice_fk" FOREIGN KEY ("invoice_id","organization_id") REFERENCES "public"."commerce_invoices"("id","organization_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "commerce_invoice_payments" ADD CONSTRAINT "commerce_invoice_payments_payment_fk" FOREIGN KEY ("payment_id","organization_id") REFERENCES "public"."payments"("id","organization_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "commerce_invoices" ADD CONSTRAINT "commerce_invoices_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "commerce_invoices" ADD CONSTRAINT "commerce_invoices_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "commerce_invoices" ADD CONSTRAINT "commerce_invoices_contact_fk" FOREIGN KEY ("contact_id","organization_id") REFERENCES "public"."crm_contacts"("id","organization_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "commerce_invoices" ADD CONSTRAINT "commerce_invoices_company_fk" FOREIGN KEY ("company_id","organization_id") REFERENCES "public"."crm_companies"("id","organization_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "commerce_invoices" ADD CONSTRAINT "commerce_invoices_deal_fk" FOREIGN KEY ("deal_id","organization_id") REFERENCES "public"."crm_deals"("id","organization_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "commerce_invoices" ADD CONSTRAINT "commerce_invoices_quote_fk" FOREIGN KEY ("quote_id","organization_id") REFERENCES "public"."commerce_quotes"("id","organization_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "commerce_payment_connections" ADD CONSTRAINT "commerce_payment_connections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "commerce_product_prices" ADD CONSTRAINT "commerce_product_prices_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "commerce_product_prices" ADD CONSTRAINT "commerce_prices_product_fk" FOREIGN KEY ("product_id","organization_id") REFERENCES "public"."commerce_products"("id","organization_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "commerce_products" ADD CONSTRAINT "commerce_products_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "commerce_products" ADD CONSTRAINT "commerce_products_tax_fk" FOREIGN KEY ("tax_rate_id","organization_id") REFERENCES "public"."commerce_tax_rates"("id","organization_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "commerce_quote_items" ADD CONSTRAINT "commerce_quote_items_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "commerce_quote_items" ADD CONSTRAINT "commerce_quote_items_quote_fk" FOREIGN KEY ("quote_id","organization_id") REFERENCES "public"."commerce_quotes"("id","organization_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "commerce_quote_items" ADD CONSTRAINT "commerce_quote_items_product_fk" FOREIGN KEY ("product_id","organization_id") REFERENCES "public"."commerce_products"("id","organization_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "commerce_quotes" ADD CONSTRAINT "commerce_quotes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "commerce_quotes" ADD CONSTRAINT "commerce_quotes_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "commerce_quotes" ADD CONSTRAINT "commerce_quotes_contact_fk" FOREIGN KEY ("contact_id","organization_id") REFERENCES "public"."crm_contacts"("id","organization_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "commerce_quotes" ADD CONSTRAINT "commerce_quotes_company_fk" FOREIGN KEY ("company_id","organization_id") REFERENCES "public"."crm_companies"("id","organization_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "commerce_quotes" ADD CONSTRAINT "commerce_quotes_deal_fk" FOREIGN KEY ("deal_id","organization_id") REFERENCES "public"."crm_deals"("id","organization_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "commerce_refunds" ADD CONSTRAINT "commerce_refunds_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "commerce_refunds" ADD CONSTRAINT "commerce_refunds_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "commerce_refunds" ADD CONSTRAINT "commerce_refunds_invoice_fk" FOREIGN KEY ("invoice_id","organization_id") REFERENCES "public"."commerce_invoices"("id","organization_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "commerce_refunds" ADD CONSTRAINT "commerce_refunds_payment_fk" FOREIGN KEY ("invoice_payment_id","organization_id") REFERENCES "public"."commerce_invoice_payments"("id","organization_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "commerce_settings" ADD CONSTRAINT "commerce_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "commerce_tax_rates" ADD CONSTRAINT "commerce_tax_rates_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "commerce_checkouts_invoice_idx" ON "commerce_checkouts" USING btree ("invoice_id");
--> statement-breakpoint
CREATE INDEX "commerce_invoice_items_invoice_idx" ON "commerce_invoice_items" USING btree ("invoice_id","position");
--> statement-breakpoint
CREATE INDEX "commerce_invoice_payments_invoice_idx" ON "commerce_invoice_payments" USING btree ("invoice_id","received_at");
--> statement-breakpoint
CREATE INDEX "commerce_invoices_org_idx" ON "commerce_invoices" USING btree ("organization_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);
--> statement-breakpoint
CREATE INDEX "commerce_invoices_contact_idx" ON "commerce_invoices" USING btree ("contact_id");
--> statement-breakpoint
CREATE INDEX "commerce_invoices_due_idx" ON "commerce_invoices" USING btree ("due_date") WHERE "commerce_invoices"."status" = 'open' and "commerce_invoices"."overdue_at" is null;
--> statement-breakpoint
CREATE INDEX "commerce_products_org_idx" ON "commerce_products" USING btree ("organization_id","archived_at");
--> statement-breakpoint
CREATE INDEX "commerce_quote_items_quote_idx" ON "commerce_quote_items" USING btree ("quote_id","position");
--> statement-breakpoint
CREATE INDEX "commerce_quotes_org_idx" ON "commerce_quotes" USING btree ("organization_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);
--> statement-breakpoint
CREATE INDEX "commerce_quotes_contact_idx" ON "commerce_quotes" USING btree ("contact_id");
--> statement-breakpoint
CREATE INDEX "commerce_refunds_invoice_idx" ON "commerce_refunds" USING btree ("invoice_id");
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "commerce_checkouts" AS PERMISSIVE FOR ALL TO public USING (app_is_system() OR organization_id = app_current_org()) WITH CHECK (app_is_system() OR organization_id = app_current_org());
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "commerce_invoice_items" AS PERMISSIVE FOR ALL TO public USING (app_is_system() OR organization_id = app_current_org()) WITH CHECK (app_is_system() OR organization_id = app_current_org());
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "commerce_invoice_payments" AS PERMISSIVE FOR ALL TO public USING (app_is_system() OR organization_id = app_current_org()) WITH CHECK (app_is_system() OR organization_id = app_current_org());
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "commerce_invoices" AS PERMISSIVE FOR ALL TO public USING (app_is_system() OR organization_id = app_current_org()) WITH CHECK (app_is_system() OR organization_id = app_current_org());
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "commerce_payment_connections" AS PERMISSIVE FOR ALL TO public USING (app_is_system() OR organization_id = app_current_org()) WITH CHECK (app_is_system() OR organization_id = app_current_org());
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "commerce_product_prices" AS PERMISSIVE FOR ALL TO public USING (app_is_system() OR organization_id = app_current_org()) WITH CHECK (app_is_system() OR organization_id = app_current_org());
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "commerce_products" AS PERMISSIVE FOR ALL TO public USING (app_is_system() OR organization_id = app_current_org()) WITH CHECK (app_is_system() OR organization_id = app_current_org());
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "commerce_quote_items" AS PERMISSIVE FOR ALL TO public USING (app_is_system() OR organization_id = app_current_org()) WITH CHECK (app_is_system() OR organization_id = app_current_org());
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "commerce_quotes" AS PERMISSIVE FOR ALL TO public USING (app_is_system() OR organization_id = app_current_org()) WITH CHECK (app_is_system() OR organization_id = app_current_org());
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "commerce_refunds" AS PERMISSIVE FOR ALL TO public USING (app_is_system() OR organization_id = app_current_org()) WITH CHECK (app_is_system() OR organization_id = app_current_org());
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "commerce_settings" AS PERMISSIVE FOR ALL TO public USING (app_is_system() OR organization_id = app_current_org()) WITH CHECK (app_is_system() OR organization_id = app_current_org());
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "commerce_tax_rates" AS PERMISSIVE FOR ALL TO public USING (app_is_system() OR organization_id = app_current_org()) WITH CHECK (app_is_system() OR organization_id = app_current_org());
