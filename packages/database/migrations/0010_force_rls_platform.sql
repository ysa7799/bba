ALTER TABLE "audit_logs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "outbox_events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "processed_events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "job_failures" FORCE ROW LEVEL SECURITY;
