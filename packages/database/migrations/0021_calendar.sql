CREATE TABLE "appointment_external_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"appointment_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"external_event_id" text,
	"synced_starts_at" timestamp with time zone,
	"status" text DEFAULT 'pending' NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appointment_external_events_status_check" CHECK ("appointment_external_events"."status" in ('pending', 'created', 'cancelled', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "appointment_external_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "appointment_manage_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"appointment_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "appointment_manage_tokens" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "appointment_participants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"appointment_id" uuid NOT NULL,
	"role" text NOT NULL,
	"calendar_id" uuid,
	"user_id" uuid,
	"contact_id" uuid,
	"name" text,
	"email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appointment_participants_role_check" CHECK ("appointment_participants"."role" in ('host', 'invitee', 'guest'))
);
--> statement-breakpoint
ALTER TABLE "appointment_participants" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "appointment_type_hosts" (
	"organization_id" uuid NOT NULL,
	"appointment_type_id" uuid NOT NULL,
	"calendar_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appointment_type_hosts_appointment_type_id_calendar_id_pk" PRIMARY KEY("appointment_type_id","calendar_id")
);
--> statement-breakpoint
ALTER TABLE "appointment_type_hosts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "appointment_types" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"duration_minutes" integer NOT NULL,
	"buffer_before_minutes" integer DEFAULT 0 NOT NULL,
	"buffer_after_minutes" integer DEFAULT 0 NOT NULL,
	"slot_interval_minutes" integer DEFAULT 30 NOT NULL,
	"minimum_notice_minutes" integer DEFAULT 60 NOT NULL,
	"maximum_advance_days" integer DEFAULT 60 NOT NULL,
	"scheduling_mode" text DEFAULT 'individual' NOT NULL,
	"location_kind" text DEFAULT 'in_person' NOT NULL,
	"location_details" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appointment_types_name_check" CHECK (char_length("appointment_types"."name") between 1 and 100),
	CONSTRAINT "appointment_types_slug_check" CHECK ("appointment_types"."slug" ~ '^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$'),
	CONSTRAINT "appointment_types_duration_check" CHECK ("appointment_types"."duration_minutes" between 5 and 720),
	CONSTRAINT "appointment_types_buffers_check" CHECK ("appointment_types"."buffer_before_minutes" between 0 and 240 and "appointment_types"."buffer_after_minutes" between 0 and 240),
	CONSTRAINT "appointment_types_interval_check" CHECK ("appointment_types"."slot_interval_minutes" between 5 and 240),
	CONSTRAINT "appointment_types_window_check" CHECK ("appointment_types"."minimum_notice_minutes" between 0 and 43200 and "appointment_types"."maximum_advance_days" between 1 and 365),
	CONSTRAINT "appointment_types_mode_check" CHECK ("appointment_types"."scheduling_mode" in ('individual', 'round_robin', 'collective')),
	CONSTRAINT "appointment_types_location_check" CHECK ("appointment_types"."location_kind" in ('in_person', 'phone', 'video', 'custom'))
);
--> statement-breakpoint
ALTER TABLE "appointment_types" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "appointments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"appointment_type_id" uuid,
	"calendar_id" uuid NOT NULL,
	"contact_id" uuid,
	"booking_page_id" uuid,
	"title" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"buffer_before_minutes" integer DEFAULT 0 NOT NULL,
	"buffer_after_minutes" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"source" text NOT NULL,
	"location_kind" text DEFAULT 'in_person' NOT NULL,
	"location_details" text,
	"join_url" text,
	"timezone" text NOT NULL,
	"invitee_name" text,
	"invitee_email" text,
	"invitee_phone" text,
	"invitee_notes" text,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" text,
	"cancellation_reason" text,
	"reminder_sent_at" timestamp with time zone,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appointments_time_check" CHECK ("appointments"."ends_at" > "appointments"."starts_at"),
	CONSTRAINT "appointments_title_check" CHECK (char_length("appointments"."title") between 1 and 200),
	CONSTRAINT "appointments_status_check" CHECK ("appointments"."status" in ('scheduled', 'cancelled', 'completed', 'no_show')),
	CONSTRAINT "appointments_source_check" CHECK ("appointments"."source" in ('booking_page', 'staff')),
	CONSTRAINT "appointments_location_check" CHECK ("appointments"."location_kind" in ('in_person', 'phone', 'video', 'custom')),
	CONSTRAINT "appointments_buffers_check" CHECK ("appointments"."buffer_before_minutes" between 0 and 240 and "appointments"."buffer_after_minutes" between 0 and 240),
	CONSTRAINT "appointments_cancelled_by_check" CHECK ("appointments"."cancelled_by" is null or "appointments"."cancelled_by" in ('invitee', 'staff'))
);
--> statement-breakpoint
ALTER TABLE "appointments" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "booking_page_types" (
	"organization_id" uuid NOT NULL,
	"booking_page_id" uuid NOT NULL,
	"appointment_type_id" uuid NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "booking_page_types_booking_page_id_appointment_type_id_pk" PRIMARY KEY("booking_page_id","appointment_type_id")
);
--> statement-breakpoint
ALTER TABLE "booking_page_types" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "booking_pages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "booking_pages_slug_check" CHECK ("booking_pages"."slug" ~ '^[a-z0-9](?:[a-z0-9-]{1,62}[a-z0-9])$'),
	CONSTRAINT "booking_pages_title_check" CHECK (char_length("booking_pages"."title") between 1 and 120)
);
--> statement-breakpoint
ALTER TABLE "booking_pages" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "calendar_availability_exceptions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"calendar_id" uuid NOT NULL,
	"date" date NOT NULL,
	"kind" text NOT NULL,
	"start_minute" integer,
	"end_minute" integer,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_availability_exceptions_kind_check" CHECK ("calendar_availability_exceptions"."kind" in ('available', 'unavailable')),
	CONSTRAINT "calendar_availability_exceptions_minutes_check" CHECK (("calendar_availability_exceptions"."start_minute" is null and "calendar_availability_exceptions"."end_minute" is null) or ("calendar_availability_exceptions"."start_minute" >= 0 and "calendar_availability_exceptions"."end_minute" <= 1440 and "calendar_availability_exceptions"."start_minute" < "calendar_availability_exceptions"."end_minute")),
	CONSTRAINT "calendar_availability_exceptions_available_check" CHECK ("calendar_availability_exceptions"."kind" = 'unavailable' or "calendar_availability_exceptions"."start_minute" is not null)
);
--> statement-breakpoint
ALTER TABLE "calendar_availability_exceptions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "calendar_availability_rules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"calendar_id" uuid NOT NULL,
	"weekday" smallint NOT NULL,
	"start_minute" integer NOT NULL,
	"end_minute" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_availability_rules_weekday_check" CHECK ("calendar_availability_rules"."weekday" between 0 and 6),
	CONSTRAINT "calendar_availability_rules_minutes_check" CHECK ("calendar_availability_rules"."start_minute" >= 0 and "calendar_availability_rules"."end_minute" <= 1440 and "calendar_availability_rules"."start_minute" < "calendar_availability_rules"."end_minute")
);
--> statement-breakpoint
ALTER TABLE "calendar_availability_rules" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "calendar_busy_blocks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"calendar_id" uuid NOT NULL,
	"appointment_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	CONSTRAINT "calendar_busy_blocks_time_check" CHECK ("calendar_busy_blocks"."ends_at" > "calendar_busy_blocks"."starts_at")
);
--> statement-breakpoint
ALTER TABLE "calendar_busy_blocks" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "calendar_connections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"calendar_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"external_calendar_id" text NOT NULL,
	"status" text DEFAULT 'configuration_required' NOT NULL,
	"credentials_ciphertext" text,
	"check_conflicts" boolean DEFAULT true NOT NULL,
	"write_events" boolean DEFAULT true NOT NULL,
	"last_synced_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_connections_provider_check" CHECK ("calendar_connections"."provider" ~ '^[a-z][a-z0-9_]{1,39}$'),
	CONSTRAINT "calendar_connections_status_check" CHECK ("calendar_connections"."status" in ('active', 'configuration_required', 'error', 'disconnected'))
);
--> statement-breakpoint
ALTER TABLE "calendar_connections" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "calendars" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"user_id" uuid,
	"name" text NOT NULL,
	"timezone" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendars_kind_check" CHECK ("calendars"."kind" in ('user', 'resource')),
	CONSTRAINT "calendars_name_check" CHECK (char_length("calendars"."name") between 1 and 100),
	CONSTRAINT "calendars_timezone_check" CHECK (char_length("calendars"."timezone") between 1 and 64)
);
--> statement-breakpoint
ALTER TABLE "calendars" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE UNIQUE INDEX "appointment_external_events_unique" ON "appointment_external_events" USING btree ("appointment_id","connection_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "appointment_manage_tokens_hash_unique" ON "appointment_manage_tokens" USING btree ("token_hash");
--> statement-breakpoint
CREATE UNIQUE INDEX "appointment_types_id_org_unique" ON "appointment_types" USING btree ("id","organization_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "appointment_types_org_slug_unique" ON "appointment_types" USING btree ("organization_id","slug");
--> statement-breakpoint
CREATE UNIQUE INDEX "appointments_id_org_unique" ON "appointments" USING btree ("id","organization_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "booking_pages_id_org_unique" ON "booking_pages" USING btree ("id","organization_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "booking_pages_slug_unique" ON "booking_pages" USING btree ("slug");
--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_busy_blocks_appointment_calendar_unique" ON "calendar_busy_blocks" USING btree ("appointment_id","calendar_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_connections_id_org_unique" ON "calendar_connections" USING btree ("id","organization_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_connections_calendar_provider_unique" ON "calendar_connections" USING btree ("calendar_id","provider") WHERE "calendar_connections"."status" <> 'disconnected';
--> statement-breakpoint
CREATE UNIQUE INDEX "calendars_id_org_unique" ON "calendars" USING btree ("id","organization_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "calendars_org_user_unique" ON "calendars" USING btree ("organization_id","user_id") WHERE "calendars"."user_id" is not null;
--> statement-breakpoint
ALTER TABLE "appointment_external_events" ADD CONSTRAINT "appointment_external_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "appointment_external_events" ADD CONSTRAINT "appointment_external_events_appointment_fk" FOREIGN KEY ("appointment_id","organization_id") REFERENCES "public"."appointments"("id","organization_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "appointment_external_events" ADD CONSTRAINT "appointment_external_events_connection_fk" FOREIGN KEY ("connection_id","organization_id") REFERENCES "public"."calendar_connections"("id","organization_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "appointment_manage_tokens" ADD CONSTRAINT "appointment_manage_tokens_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "appointment_manage_tokens" ADD CONSTRAINT "appointment_manage_tokens_appointment_fk" FOREIGN KEY ("appointment_id","organization_id") REFERENCES "public"."appointments"("id","organization_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "appointment_participants" ADD CONSTRAINT "appointment_participants_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "appointment_participants" ADD CONSTRAINT "appointment_participants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "appointment_participants" ADD CONSTRAINT "appointment_participants_appointment_fk" FOREIGN KEY ("appointment_id","organization_id") REFERENCES "public"."appointments"("id","organization_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "appointment_participants" ADD CONSTRAINT "appointment_participants_calendar_fk" FOREIGN KEY ("calendar_id","organization_id") REFERENCES "public"."calendars"("id","organization_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "appointment_participants" ADD CONSTRAINT "appointment_participants_contact_fk" FOREIGN KEY ("contact_id","organization_id") REFERENCES "public"."crm_contacts"("id","organization_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "appointment_type_hosts" ADD CONSTRAINT "appointment_type_hosts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "appointment_type_hosts" ADD CONSTRAINT "appointment_type_hosts_type_fk" FOREIGN KEY ("appointment_type_id","organization_id") REFERENCES "public"."appointment_types"("id","organization_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "appointment_type_hosts" ADD CONSTRAINT "appointment_type_hosts_calendar_fk" FOREIGN KEY ("calendar_id","organization_id") REFERENCES "public"."calendars"("id","organization_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "appointment_types" ADD CONSTRAINT "appointment_types_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "appointment_types" ADD CONSTRAINT "appointment_types_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_type_fk" FOREIGN KEY ("appointment_type_id","organization_id") REFERENCES "public"."appointment_types"("id","organization_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_calendar_fk" FOREIGN KEY ("calendar_id","organization_id") REFERENCES "public"."calendars"("id","organization_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_contact_fk" FOREIGN KEY ("contact_id","organization_id") REFERENCES "public"."crm_contacts"("id","organization_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_booking_page_fk" FOREIGN KEY ("booking_page_id","organization_id") REFERENCES "public"."booking_pages"("id","organization_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "booking_page_types" ADD CONSTRAINT "booking_page_types_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "booking_page_types" ADD CONSTRAINT "booking_page_types_page_fk" FOREIGN KEY ("booking_page_id","organization_id") REFERENCES "public"."booking_pages"("id","organization_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "booking_page_types" ADD CONSTRAINT "booking_page_types_type_fk" FOREIGN KEY ("appointment_type_id","organization_id") REFERENCES "public"."appointment_types"("id","organization_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "booking_pages" ADD CONSTRAINT "booking_pages_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "calendar_availability_exceptions" ADD CONSTRAINT "calendar_availability_exceptions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "calendar_availability_exceptions" ADD CONSTRAINT "calendar_availability_exceptions_calendar_fk" FOREIGN KEY ("calendar_id","organization_id") REFERENCES "public"."calendars"("id","organization_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "calendar_availability_rules" ADD CONSTRAINT "calendar_availability_rules_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "calendar_availability_rules" ADD CONSTRAINT "calendar_availability_rules_calendar_fk" FOREIGN KEY ("calendar_id","organization_id") REFERENCES "public"."calendars"("id","organization_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "calendar_busy_blocks" ADD CONSTRAINT "calendar_busy_blocks_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "calendar_busy_blocks" ADD CONSTRAINT "calendar_busy_blocks_calendar_fk" FOREIGN KEY ("calendar_id","organization_id") REFERENCES "public"."calendars"("id","organization_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "calendar_busy_blocks" ADD CONSTRAINT "calendar_busy_blocks_appointment_fk" FOREIGN KEY ("appointment_id","organization_id") REFERENCES "public"."appointments"("id","organization_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "calendar_connections" ADD CONSTRAINT "calendar_connections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "calendar_connections" ADD CONSTRAINT "calendar_connections_calendar_fk" FOREIGN KEY ("calendar_id","organization_id") REFERENCES "public"."calendars"("id","organization_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "calendars" ADD CONSTRAINT "calendars_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "calendars" ADD CONSTRAINT "calendars_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "appointment_manage_tokens_appointment_idx" ON "appointment_manage_tokens" USING btree ("appointment_id");
--> statement-breakpoint
CREATE INDEX "appointment_participants_appointment_idx" ON "appointment_participants" USING btree ("appointment_id");
--> statement-breakpoint
CREATE INDEX "appointment_participants_user_idx" ON "appointment_participants" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "appointment_type_hosts_calendar_idx" ON "appointment_type_hosts" USING btree ("calendar_id");
--> statement-breakpoint
CREATE INDEX "appointments_org_starts_idx" ON "appointments" USING btree ("organization_id","starts_at","id");
--> statement-breakpoint
CREATE INDEX "appointments_calendar_starts_idx" ON "appointments" USING btree ("calendar_id","starts_at");
--> statement-breakpoint
CREATE INDEX "appointments_contact_idx" ON "appointments" USING btree ("contact_id");
--> statement-breakpoint
CREATE INDEX "appointments_reminder_idx" ON "appointments" USING btree ("starts_at") WHERE "appointments"."status" = 'scheduled' and "appointments"."reminder_sent_at" is null;
--> statement-breakpoint
CREATE INDEX "booking_page_types_type_idx" ON "booking_page_types" USING btree ("appointment_type_id");
--> statement-breakpoint
CREATE INDEX "calendar_availability_exceptions_calendar_idx" ON "calendar_availability_exceptions" USING btree ("calendar_id","date");
--> statement-breakpoint
CREATE INDEX "calendar_availability_rules_calendar_idx" ON "calendar_availability_rules" USING btree ("calendar_id","weekday");
--> statement-breakpoint
CREATE INDEX "calendar_busy_blocks_calendar_idx" ON "calendar_busy_blocks" USING btree ("calendar_id","starts_at");
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "appointment_external_events" AS PERMISSIVE FOR ALL TO public USING (app_is_system() OR organization_id = app_current_org()) WITH CHECK (app_is_system() OR organization_id = app_current_org());
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "appointment_manage_tokens" AS PERMISSIVE FOR ALL TO public USING (app_is_system() OR organization_id = app_current_org()) WITH CHECK (app_is_system() OR organization_id = app_current_org());
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "appointment_participants" AS PERMISSIVE FOR ALL TO public USING (app_is_system() OR organization_id = app_current_org()) WITH CHECK (app_is_system() OR organization_id = app_current_org());
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "appointment_type_hosts" AS PERMISSIVE FOR ALL TO public USING (app_is_system() OR organization_id = app_current_org()) WITH CHECK (app_is_system() OR organization_id = app_current_org());
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "appointment_types" AS PERMISSIVE FOR ALL TO public USING (app_is_system() OR organization_id = app_current_org()) WITH CHECK (app_is_system() OR organization_id = app_current_org());
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "appointments" AS PERMISSIVE FOR ALL TO public USING (app_is_system() OR organization_id = app_current_org()) WITH CHECK (app_is_system() OR organization_id = app_current_org());
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "booking_page_types" AS PERMISSIVE FOR ALL TO public USING (app_is_system() OR organization_id = app_current_org()) WITH CHECK (app_is_system() OR organization_id = app_current_org());
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "booking_pages" AS PERMISSIVE FOR ALL TO public USING (app_is_system() OR organization_id = app_current_org()) WITH CHECK (app_is_system() OR organization_id = app_current_org());
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "calendar_availability_exceptions" AS PERMISSIVE FOR ALL TO public USING (app_is_system() OR organization_id = app_current_org()) WITH CHECK (app_is_system() OR organization_id = app_current_org());
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "calendar_availability_rules" AS PERMISSIVE FOR ALL TO public USING (app_is_system() OR organization_id = app_current_org()) WITH CHECK (app_is_system() OR organization_id = app_current_org());
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "calendar_busy_blocks" AS PERMISSIVE FOR ALL TO public USING (app_is_system() OR organization_id = app_current_org()) WITH CHECK (app_is_system() OR organization_id = app_current_org());
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "calendar_connections" AS PERMISSIVE FOR ALL TO public USING (app_is_system() OR organization_id = app_current_org()) WITH CHECK (app_is_system() OR organization_id = app_current_org());
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "calendars" AS PERMISSIVE FOR ALL TO public USING (app_is_system() OR organization_id = app_current_org()) WITH CHECK (app_is_system() OR organization_id = app_current_org());
