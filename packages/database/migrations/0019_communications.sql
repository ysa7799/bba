CREATE TABLE "channel_connections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"provider" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'configuration_required' NOT NULL,
	"address" text NOT NULL,
	"external_account_id" text,
	"webhook_token_hash" text NOT NULL,
	"credentials_ciphertext" text,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_error" text,
	"last_inbound_at" timestamp with time zone,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_connections_channel_check" CHECK ("channel_connections"."channel" in ('email', 'whatsapp', 'sms')),
	CONSTRAINT "channel_connections_status_check" CHECK ("channel_connections"."status" in ('active', 'configuration_required', 'error', 'disconnected')),
	CONSTRAINT "channel_connections_provider_check" CHECK ("channel_connections"."provider" ~ '^[a-z][a-z0-9_]{1,39}$'),
	CONSTRAINT "channel_connections_name_check" CHECK (char_length("channel_connections"."name") between 1 and 100)
);
--> statement-breakpoint
ALTER TABLE "channel_connections" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "channel_templates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"name" text NOT NULL,
	"language" text NOT NULL,
	"category" text NOT NULL,
	"body" text NOT NULL,
	"variable_count" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'approved' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_templates_name_check" CHECK ("channel_templates"."name" ~ '^[a-z0-9_]+$' and char_length("channel_templates"."name") <= 512),
	CONSTRAINT "channel_templates_language_check" CHECK ("channel_templates"."language" ~ '^[a-z]{2,3}(_[A-Z]{2})?$'),
	CONSTRAINT "channel_templates_variables_check" CHECK ("channel_templates"."variable_count" between 0 and 20),
	CONSTRAINT "channel_templates_category_check" CHECK ("channel_templates"."category" in ('marketing', 'utility', 'authentication')),
	CONSTRAINT "channel_templates_status_check" CHECK ("channel_templates"."status" in ('approved', 'pending', 'rejected', 'disabled'))
);
--> statement-breakpoint
ALTER TABLE "channel_templates" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "communication_webhook_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"connection_id" uuid,
	"organization_id" uuid,
	"signature_valid" boolean NOT NULL,
	"outcome" text NOT NULL,
	"event_count" integer DEFAULT 0 NOT NULL,
	"error" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "communication_webhook_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "conversation_participants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"role" text DEFAULT 'counterpart' NOT NULL,
	"contact_id" uuid,
	"user_id" uuid,
	"address" text,
	"display_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_participants_kind_check" CHECK ("conversation_participants"."kind" in ('contact', 'external', 'user')),
	CONSTRAINT "conversation_participants_role_check" CHECK ("conversation_participants"."role" in ('counterpart', 'cc', 'member'))
);
--> statement-breakpoint
ALTER TABLE "conversation_participants" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "conversation_tags" (
	"organization_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_tags_conversation_id_tag_id_pk" PRIMARY KEY("conversation_id","tag_id")
);
--> statement-breakpoint
ALTER TABLE "conversation_tags" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"connection_id" uuid NOT NULL,
	"contact_id" uuid,
	"counterpart_address" text NOT NULL,
	"counterpart_name" text,
	"subject" text,
	"status" text DEFAULT 'open' NOT NULL,
	"assignee_user_id" uuid,
	"unread_count" integer DEFAULT 0 NOT NULL,
	"last_message_at" timestamp with time zone,
	"last_message_preview" text,
	"last_message_direction" text,
	"last_inbound_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversations_channel_check" CHECK ("conversations"."channel" in ('email', 'whatsapp', 'sms')),
	CONSTRAINT "conversations_status_check" CHECK ("conversations"."status" in ('open', 'closed')),
	CONSTRAINT "conversations_unread_check" CHECK ("conversations"."unread_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "conversations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "message_attachments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" bigint,
	"provider_media_id" text,
	"storage_key" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_attachments_status_check" CHECK ("message_attachments"."status" in ('pending', 'available', 'unavailable')),
	CONSTRAINT "message_attachments_name_check" CHECK (char_length("message_attachments"."file_name") between 1 and 255)
);
--> statement-breakpoint
ALTER TABLE "message_attachments" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"status" text NOT NULL,
	"author_user_id" uuid,
	"subject" text,
	"body_text" text DEFAULT '' NOT NULL,
	"template" jsonb,
	"provider_message_id" text,
	"error_code" text,
	"error_message" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"provider_timestamp" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_direction_check" CHECK ("messages"."direction" in ('inbound', 'outbound', 'internal')),
	CONSTRAINT "messages_status_check" CHECK ("messages"."status" in ('received', 'queued', 'sending', 'sent', 'delivered', 'read', 'failed')),
	CONSTRAINT "messages_body_check" CHECK (char_length("messages"."body_text") <= 65536)
);
--> statement-breakpoint
ALTER TABLE "messages" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE UNIQUE INDEX "channel_connections_id_org_unique" ON "channel_connections" USING btree ("id","organization_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "channel_connections_webhook_token_unique" ON "channel_connections" USING btree ("webhook_token_hash");
--> statement-breakpoint
CREATE UNIQUE INDEX "channel_connections_provider_account_unique" ON "channel_connections" USING btree ("provider","external_account_id") WHERE "channel_connections"."external_account_id" is not null and "channel_connections"."status" <> 'disconnected';
--> statement-breakpoint
CREATE UNIQUE INDEX "channel_templates_unique" ON "channel_templates" USING btree ("connection_id","name","language");
--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_participants_address_unique" ON "conversation_participants" USING btree ("conversation_id","role","address") WHERE "conversation_participants"."address" is not null;
--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_id_org_unique" ON "conversations" USING btree ("id","organization_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_connection_counterpart_unique" ON "conversations" USING btree ("connection_id","counterpart_address");
--> statement-breakpoint
CREATE UNIQUE INDEX "messages_id_org_unique" ON "messages" USING btree ("id","organization_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "messages_provider_id_unique" ON "messages" USING btree ("connection_id","provider_message_id") WHERE "messages"."provider_message_id" is not null;
--> statement-breakpoint
ALTER TABLE "channel_connections" ADD CONSTRAINT "channel_connections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "channel_connections" ADD CONSTRAINT "channel_connections_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "channel_templates" ADD CONSTRAINT "channel_templates_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "channel_templates" ADD CONSTRAINT "channel_templates_connection_fk" FOREIGN KEY ("connection_id","organization_id") REFERENCES "public"."channel_connections"("id","organization_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "communication_webhook_events" ADD CONSTRAINT "communication_webhook_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "conversation_participants" ADD CONSTRAINT "conversation_participants_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "conversation_participants" ADD CONSTRAINT "conversation_participants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "conversation_participants" ADD CONSTRAINT "conversation_participants_conversation_fk" FOREIGN KEY ("conversation_id","organization_id") REFERENCES "public"."conversations"("id","organization_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "conversation_participants" ADD CONSTRAINT "conversation_participants_contact_fk" FOREIGN KEY ("contact_id","organization_id") REFERENCES "public"."crm_contacts"("id","organization_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "conversation_tags" ADD CONSTRAINT "conversation_tags_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "conversation_tags" ADD CONSTRAINT "conversation_tags_conversation_fk" FOREIGN KEY ("conversation_id","organization_id") REFERENCES "public"."conversations"("id","organization_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "conversation_tags" ADD CONSTRAINT "conversation_tags_tag_fk" FOREIGN KEY ("tag_id","organization_id") REFERENCES "public"."crm_tags"("id","organization_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_assignee_user_id_users_id_fk" FOREIGN KEY ("assignee_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_connection_fk" FOREIGN KEY ("connection_id","organization_id") REFERENCES "public"."channel_connections"("id","organization_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_contact_fk" FOREIGN KEY ("contact_id","organization_id") REFERENCES "public"."crm_contacts"("id","organization_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_message_fk" FOREIGN KEY ("message_id","organization_id") REFERENCES "public"."messages"("id","organization_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_fk" FOREIGN KEY ("conversation_id","organization_id") REFERENCES "public"."conversations"("id","organization_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_connection_fk" FOREIGN KEY ("connection_id","organization_id") REFERENCES "public"."channel_connections"("id","organization_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "channel_connections_org_idx" ON "channel_connections" USING btree ("organization_id","channel");
--> statement-breakpoint
CREATE INDEX "communication_webhook_events_received_idx" ON "communication_webhook_events" USING btree ("received_at");
--> statement-breakpoint
CREATE INDEX "conversation_participants_conversation_idx" ON "conversation_participants" USING btree ("conversation_id");
--> statement-breakpoint
CREATE INDEX "conversation_tags_tag_idx" ON "conversation_tags" USING btree ("tag_id");
--> statement-breakpoint
CREATE INDEX "conversations_inbox_idx" ON "conversations" USING btree ("organization_id","status","last_message_at" DESC NULLS LAST,"id" DESC NULLS LAST);
--> statement-breakpoint
CREATE INDEX "conversations_assignee_idx" ON "conversations" USING btree ("organization_id","assignee_user_id","status");
--> statement-breakpoint
CREATE INDEX "conversations_contact_idx" ON "conversations" USING btree ("contact_id");
--> statement-breakpoint
CREATE INDEX "message_attachments_message_idx" ON "message_attachments" USING btree ("message_id");
--> statement-breakpoint
CREATE INDEX "messages_conversation_idx" ON "messages" USING btree ("conversation_id","created_at","id");
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "channel_connections" AS PERMISSIVE FOR ALL TO public USING (app_is_system() OR organization_id = app_current_org()) WITH CHECK (app_is_system() OR organization_id = app_current_org());
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "channel_templates" AS PERMISSIVE FOR ALL TO public USING (app_is_system() OR organization_id = app_current_org()) WITH CHECK (app_is_system() OR organization_id = app_current_org());
--> statement-breakpoint
CREATE POLICY "system_only" ON "communication_webhook_events" AS PERMISSIVE FOR ALL TO public USING (app_is_system()) WITH CHECK (app_is_system());
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "conversation_participants" AS PERMISSIVE FOR ALL TO public USING (app_is_system() OR organization_id = app_current_org()) WITH CHECK (app_is_system() OR organization_id = app_current_org());
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "conversation_tags" AS PERMISSIVE FOR ALL TO public USING (app_is_system() OR organization_id = app_current_org()) WITH CHECK (app_is_system() OR organization_id = app_current_org());
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "conversations" AS PERMISSIVE FOR ALL TO public USING (app_is_system() OR organization_id = app_current_org()) WITH CHECK (app_is_system() OR organization_id = app_current_org());
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "message_attachments" AS PERMISSIVE FOR ALL TO public USING (app_is_system() OR organization_id = app_current_org()) WITH CHECK (app_is_system() OR organization_id = app_current_org());
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "messages" AS PERMISSIVE FOR ALL TO public USING (app_is_system() OR organization_id = app_current_org()) WITH CHECK (app_is_system() OR organization_id = app_current_org());
