CREATE TABLE "files" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"entity_type" text,
	"entity_id" uuid,
	"name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"sha256" text NOT NULL,
	"storage_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"uploaded_by_user_id" uuid,
	"deleted_at" timestamp with time zone,
	"purged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "files_size_check" CHECK ("files"."size_bytes" > 0),
	CONSTRAINT "files_status_check" CHECK ("files"."status" in ('pending', 'ready', 'deleted')),
	CONSTRAINT "files_entity_check" CHECK (("files"."entity_type" is null) = ("files"."entity_id" is null) and ("files"."entity_type" is null or "files"."entity_type" in ('contact', 'company', 'deal'))),
	CONSTRAINT "files_name_check" CHECK (char_length("files"."name") between 1 and 200)
);
--> statement-breakpoint
ALTER TABLE "files" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "notification_preferences" (
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"in_app" boolean NOT NULL,
	"email" boolean NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_preferences_organization_id_user_id_type_pk" PRIMARY KEY("organization_id","user_id","type")
);
--> statement-breakpoint
ALTER TABLE "notification_preferences" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"link" text,
	"subject_type" text,
	"subject_id" uuid,
	"source_event_id" uuid NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_title_check" CHECK (char_length("notifications"."title") between 1 and 300),
	CONSTRAINT "notifications_link_check" CHECK ("notifications"."link" is null or "notifications"."link" ~ '^/o/[0-9a-f-]{36}/')
);
--> statement-breakpoint
ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE UNIQUE INDEX "files_id_org_unique" ON "files" USING btree ("id","organization_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "files_storage_key_unique" ON "files" USING btree ("storage_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_event_unique" ON "notifications" USING btree ("user_id","type","source_event_id");
--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "files_entity_idx" ON "files" USING btree ("organization_id","entity_type","entity_id","created_at" DESC NULLS LAST) WHERE "files"."status" = 'ready';
--> statement-breakpoint
CREATE INDEX "files_cleanup_idx" ON "files" USING btree ("status","updated_at");
--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "notifications" USING btree ("organization_id","user_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);
--> statement-breakpoint
CREATE INDEX "notifications_unread_idx" ON "notifications" USING btree ("organization_id","user_id") WHERE "notifications"."read_at" is null;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "files" AS PERMISSIVE FOR ALL TO public USING (app_is_system() OR organization_id = app_current_org()) WITH CHECK (app_is_system() OR organization_id = app_current_org());
--> statement-breakpoint
CREATE POLICY "notification_preferences_owner" ON "notification_preferences" AS PERMISSIVE FOR ALL TO public USING (app_is_system() OR (organization_id = app_current_org() AND user_id = app_current_user())) WITH CHECK (app_is_system() OR (organization_id = app_current_org() AND user_id = app_current_user()));
--> statement-breakpoint
CREATE POLICY "notifications_owner" ON "notifications" AS PERMISSIVE FOR ALL TO public USING (app_is_system() OR (organization_id = app_current_org() AND user_id = app_current_user())) WITH CHECK (app_is_system() OR (organization_id = app_current_org() AND user_id = app_current_user()));
