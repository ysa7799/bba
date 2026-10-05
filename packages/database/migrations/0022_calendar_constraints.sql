ALTER TABLE "calendars" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "calendar_availability_rules" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "calendar_availability_exceptions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "appointment_types" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "appointment_type_hosts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "booking_pages" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "booking_page_types" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "appointments" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "appointment_manage_tokens" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "appointment_participants" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "calendar_busy_blocks" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "calendar_connections" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "appointment_external_events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Double-booking guard: no two busy blocks (bookings including their buffers) may overlap on the
-- same calendar. Enforced by the database, so concurrent bookings cannot both succeed.
CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint
ALTER TABLE "calendar_busy_blocks" ADD CONSTRAINT "calendar_busy_blocks_no_overlap"
  EXCLUDE USING gist ("calendar_id" WITH =, tstzrange("starts_at", "ends_at", '[)') WITH &&);
