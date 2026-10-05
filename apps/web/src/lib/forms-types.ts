/** API response shapes for forms (mirrors `@businessos/forms`; the API is the source of truth). */

export const FIELD_TYPES = [
  'text',
  'textarea',
  'email',
  'phone',
  'number',
  'date',
  'select',
  'multi_select',
  'checkbox',
  'radio',
  'hidden',
  'consent',
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const CHOICE_TYPES: readonly FieldType[] = ['select', 'multi_select', 'radio'];

export interface FieldOption {
  value: string;
  label: string;
}

export interface BuilderField {
  key: string;
  type: FieldType;
  label: string;
  required: boolean;
  placeholder: string | null;
  helpText: string | null;
  options: FieldOption[];
  validation: { min?: number; max?: number; maxLength?: number; maxSelections?: number };
  defaultValue: string | null;
  target: string | null;
}

export const LIFECYCLE_STAGES = [
  'subscriber',
  'lead',
  'qualified',
  'opportunity',
  'customer',
  'evangelist',
  'other',
] as const;

export interface FormSettings {
  title: string | null;
  description: string | null;
  submitLabel: string;
  successMessage: string;
  redirectUrl: string | null;
  contact: {
    enabled: boolean;
    ownerUserId: string | null;
    lifecycleStage: (typeof LIFECYCLE_STAGES)[number] | null;
    tagIds: string[];
    addNote: boolean;
  };
  deal: { pipelineId: string; stageId: string | null } | null;
  captcha: boolean;
  embedOrigins: string[];
}

export interface FormVersionView {
  id: string;
  number: number;
  status: 'draft' | 'published' | 'retired';
  settings: FormSettings;
  fields: BuilderField[];
  publishedAt: string | null;
}

export interface FormSummary {
  id: string;
  name: string;
  slug: string;
  status: 'active' | 'archived';
  publishedVersion: number | null;
  publishedAt: string | null;
  hasDraft: boolean;
  submissionCount: number;
  lastSubmissionAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FormDetail extends FormSummary {
  draft: FormVersionView | null;
  published: FormVersionView | null;
}

export interface BuilderOptions {
  targets: {
    target: string;
    /** Custom field label (standard targets are labelled by the UI). */
    label: string | null;
    fieldTypes: FieldType[];
    /** A custom select's options (choice fields must use them). */
    options: FieldOption[] | null;
  }[];
  tags: { id: string; name: string; color: string }[];
  pipelines: { id: string; name: string; stages: { id: string; name: string }[] }[];
  members: { userId: string; name: string; email: string }[];
  captcha: { status: 'CONFIGURED' | 'CONFIGURATION_REQUIRED'; provider: string | null };
}

export interface PublicField {
  key: string;
  type: FieldType;
  label: string;
  required: boolean;
  placeholder: string | null;
  helpText: string | null;
  options: FieldOption[];
  validation: { min?: number; max?: number; maxLength?: number; maxSelections?: number };
  defaultValue: string | null;
}

export interface PublicFormView {
  form: {
    slug: string;
    title: string;
    description: string | null;
    submitLabel: string;
    fields: PublicField[];
  };
  organization: { name: string };
  renderToken: string;
  captcha: { provider: string; siteKey: string } | null;
  accepting: boolean;
}

export interface SubmissionSummary {
  id: string;
  formId: string;
  versionNumber: number;
  status: 'accepted' | 'spam';
  submittedAt: string;
  preview: { label: string; value: string }[];
  contact: { id: string; name: string } | null;
  dealId: string | null;
}

export interface SubmissionDetail extends SubmissionSummary {
  answers: { key: string; label: string; type: FieldType; value: string }[];
  spamReasons: string[];
  processingNotes: string[];
  userAgent: string | null;
}
