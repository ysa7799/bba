CREATE INDEX "crm_deals_org_closed_idx" ON "crm_deals" USING btree ("organization_id","closed_at") WHERE "crm_deals"."closed_at" is not null;--> statement-breakpoint
CREATE INDEX "crm_tasks_org_completed_idx" ON "crm_tasks" USING btree ("organization_id","completed_at") WHERE "crm_tasks"."completed_at" is not null;--> statement-breakpoint
CREATE INDEX "conversations_org_created_idx" ON "conversations" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "messages_org_created_idx" ON "messages" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "form_submissions_org_submitted_idx" ON "form_submissions" USING btree ("organization_id","submitted_at");--> statement-breakpoint
CREATE INDEX "automation_runs_org_started_idx" ON "automation_runs" USING btree ("organization_id","started_at");--> statement-breakpoint
CREATE INDEX "commerce_invoice_payments_org_received_idx" ON "commerce_invoice_payments" USING btree ("organization_id","received_at");--> statement-breakpoint
CREATE INDEX "commerce_invoices_org_issued_idx" ON "commerce_invoices" USING btree ("organization_id","issue_date") WHERE "commerce_invoices"."issue_date" is not null;--> statement-breakpoint
CREATE INDEX "commerce_refunds_org_created_idx" ON "commerce_refunds" USING btree ("organization_id","created_at");