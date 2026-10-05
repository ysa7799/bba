// Response shapes of the CRM API (`/app/orgs/:orgId/crm/*`).

export interface MoneyJson {
  amount: string;
  currency: string;
}

export interface TagSummary {
  id: string;
  name: string;
  color: string;
}

export type LifecycleStage =
  'subscriber' | 'lead' | 'qualified' | 'opportunity' | 'customer' | 'evangelist' | 'other';

export const LIFECYCLE_STAGES: LifecycleStage[] = [
  'subscriber',
  'lead',
  'qualified',
  'opportunity',
  'customer',
  'evangelist',
  'other',
];

export interface ContactSummary {
  id: string;
  displayName: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  whatsappPhone: string | null;
  jobTitle: string | null;
  source: string;
  lifecycleStage: LifecycleStage;
  status: 'active' | 'inactive';
  ownerUserId: string | null;
  ownerName: string | null;
  primaryCompany: { id: string; name: string } | null;
  tags: TagSummary[];
  customFields: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ContactDetail extends ContactSummary {
  createdByUserId: string | null;
  companies: { companyId: string; name: string; role: string | null; isPrimary: boolean }[];
}

export interface CompanySummary {
  id: string;
  name: string;
  domain: string | null;
  phone: string | null;
  website: string | null;
  industry: string | null;
  employeeCount: number | null;
  city: string | null;
  countryCode: string | null;
  ownerUserId: string | null;
  ownerName: string | null;
  contactCount: number;
  tags: TagSummary[];
  customFields: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export type StageKind = 'open' | 'won' | 'lost';

export interface StageSummary {
  id: string;
  name: string;
  position: number;
  probability: number;
  kind: StageKind;
}

export interface PipelineDetail {
  id: string;
  name: string;
  isDefault: boolean;
  position: number;
  archived: boolean;
  stages: StageSummary[];
}

export interface DealSummary {
  id: string;
  name: string;
  pipelineId: string;
  pipelineName: string;
  stageId: string;
  stageName: string;
  status: StageKind;
  contact: { id: string; name: string } | null;
  company: { id: string; name: string } | null;
  ownerUserId: string | null;
  ownerName: string | null;
  value: MoneyJson | null;
  currency: string;
  probability: number;
  probabilityOverride: number | null;
  expectedCloseDate: string | null;
  closedAt: string | null;
  lostReason: string | null;
  stageEnteredAt: string;
  position: number;
  tags: TagSummary[];
  customFields: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface BoardStage extends StageSummary {
  deals: DealSummary[];
  count: number;
  totals: MoneyJson[];
}

export interface DealBoard {
  pipeline: { id: string; name: string; isDefault: boolean };
  stages: BoardStage[];
}

export interface TaskSummary {
  id: string;
  title: string;
  description: string | null;
  dueAt: string | null;
  priority: 'low' | 'normal' | 'high';
  status: 'open' | 'completed';
  completedAt: string | null;
  assigneeUserId: string | null;
  assigneeName: string | null;
  contact: { id: string; name: string } | null;
  company: { id: string; name: string } | null;
  deal: { id: string; name: string } | null;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NoteSummary {
  id: string;
  body: string;
  parent: { type: 'contact' | 'company' | 'deal'; id: string };
  authorUserId: string | null;
  authorName: string | null;
  edited: boolean;
  createdAt: string;
  updatedAt: string;
}

export type CustomFieldType =
  | 'text'
  | 'textarea'
  | 'integer'
  | 'decimal'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'select'
  | 'multi_select'
  | 'email'
  | 'phone'
  | 'url'
  | 'user';

export const CUSTOM_FIELD_TYPES: CustomFieldType[] = [
  'text',
  'textarea',
  'integer',
  'decimal',
  'boolean',
  'date',
  'datetime',
  'select',
  'multi_select',
  'email',
  'phone',
  'url',
  'user',
];

export interface CustomFieldDefinition {
  id: string;
  entityType: 'contact' | 'company' | 'deal';
  key: string;
  label: string;
  type: CustomFieldType;
  options: { value: string; label: string }[];
  required: boolean;
  helpText: string | null;
  position: number;
  archived: boolean;
}

export interface Assignee {
  userId: string;
  name: string;
}

export interface SearchHit {
  type: 'contact' | 'company' | 'deal';
  id: string;
  title: string;
  subtitle: string | null;
}

export interface ImportDetail {
  id: string;
  entityType: 'contact' | 'company';
  status: 'uploaded' | 'queued' | 'processing' | 'completed' | 'failed' | 'canceled';
  fileName: string;
  headers: string[];
  mapping: Record<string, string>;
  duplicatePolicy: 'skip' | 'update';
  totalRows: number;
  processedRows: number;
  createdCount: number;
  updatedCount: number;
  skippedCount: number;
  failedCount: number;
  failureReason: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface ImportFull extends ImportDetail {
  fields: { key: string; label: string }[];
  sampleRows: string[][];
  errors: { rowNumber: number; status: string; error: string | null }[];
}

export interface ImportPreviewRow {
  rowNumber: number;
  values: Record<string, string>;
  error: string | null;
}

export interface ExportSummary {
  id: string;
  entityType: 'contact' | 'company' | 'deal';
  status: 'queued' | 'processing' | 'completed' | 'failed' | 'expired';
  rowCount: number | null;
  contentBytes: number | null;
  failureReason: string | null;
  downloadCount: number;
  expiresAt: string;
  completedAt: string | null;
  createdAt: string;
}

/** Currencies supported by the API (mirrors the shared currency registry). */
export const CURRENCIES = [
  'BHD',
  'SAR',
  'AED',
  'KWD',
  'OMR',
  'QAR',
  'JOD',
  'IQD',
  'LYD',
  'TND',
  'EGP',
  'MAD',
  'USD',
  'EUR',
  'GBP',
  'CHF',
  'CAD',
  'AUD',
  'INR',
  'PKR',
  'CNY',
  'SGD',
  'TRY',
  'JPY',
  'KRW',
] as const;

export type ActivityCategory =
  'note' | 'task' | 'deal' | 'communication' | 'appointment' | 'form' | 'record';

export interface ActivitySummary {
  id: string;
  type: string;
  category: ActivityCategory;
  channel: string | null;
  occurredAt: string;
  actor: { type: string; userId: string | null; name: string | null };
  subject: { type: string; id: string };
  contactId: string | null;
  companyId: string | null;
  dealId: string | null;
  summary: string;
  metadata: Record<string, unknown>;
  manual: boolean;
}

export const LOGGABLE_ACTIVITY_TYPES = [
  'call.logged',
  'meeting.logged',
  'email.logged',
  'whatsapp.logged',
  'sms.logged',
] as const;
