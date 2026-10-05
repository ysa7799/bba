/** API shapes for automation (mirrors `@businessos/automation`; the API is the source of truth). */

export const TRIGGER_TYPES = [
  'contact.created',
  'contact.updated',
  'contact.tag_added',
  'form.submitted',
  'deal.created',
  'deal.stage_changed',
  'appointment.booked',
  'task.completed',
  'message.received',
  'webhook.received',
] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];

export const ACTION_TYPES = [
  'contact.create',
  'contact.update',
  'contact.add_tag',
  'contact.remove_tag',
  'contact.assign_owner',
  'deal.create',
  'deal.move',
  'task.create',
  'message.email',
  'message.sms',
  'message.whatsapp',
  'http.request',
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export type NodeType = 'action' | 'condition' | 'wait';

export interface DefinitionNode {
  key: string;
  type: NodeType;
  action: ActionType | null;
  label: string | null;
  config: Record<string, unknown>;
}

export interface Definition {
  trigger: { type: TriggerType; config: Record<string, unknown> };
  nodes: DefinitionNode[];
  edges: { from: string; to: string; branch: 'next' | 'true' | 'false' }[];
  entry: string | null;
}

export interface VersionView {
  id: string;
  number: number;
  status: 'draft' | 'published' | 'retired';
  definition: Definition;
  publishedAt: string | null;
}

export type WorkflowStatus = 'draft' | 'active' | 'paused' | 'archived';

export interface WorkflowSummary {
  id: string;
  name: string;
  description: string | null;
  status: WorkflowStatus;
  triggerType: TriggerType;
  publishedVersion: number | null;
  hasDraft: boolean;
  webhookConfigured: boolean;
  runs: { total: number; failed: number; lastStartedAt: string | null };
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowDetail extends WorkflowSummary {
  draft: VersionView | null;
  published: VersionView | null;
}

export interface AutomationOptions {
  triggers: TriggerType[];
  actions: ActionType[];
  tags: { id: string; name: string; color: string }[];
  pipelines: {
    id: string;
    name: string;
    stages: { id: string; name: string; kind: 'open' | 'won' | 'lost' }[];
  }[];
  members: { userId: string; name: string; email: string }[];
  channels: { id: string; channel: 'email' | 'whatsapp' | 'sms'; name: string; status: string }[];
  whatsappTemplates: {
    connectionId: string;
    name: string;
    language: string;
    variableCount: number;
  }[];
  forms: { id: string; name: string }[];
  appointmentTypes: { id: string; name: string }[];
  contactFields: { key: string; label: string; type: string }[];
}

export type RunStatus = 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled' | 'skipped';

export interface RunSummary {
  id: string;
  workflowId: string;
  versionNumber: number;
  status: RunStatus;
  triggerType: string;
  contact: { id: string; name: string } | null;
  dealId: string | null;
  currentNodeKey: string | null;
  resumeAt: string | null;
  error: string | null;
  depth: number;
  startedAt: string;
  finishedAt: string | null;
}

export interface RunDetail extends RunSummary {
  triggerData: Record<string, unknown>;
  steps: {
    nodeKey: string;
    nodeType: NodeType;
    action: string | null;
    status: string;
    attempts: number;
    resumeAt: string | null;
    output: Record<string, unknown>;
    error: string | null;
    startedAt: string;
    finishedAt: string | null;
  }[];
  logs: { nodeKey: string | null; level: 'info' | 'warn' | 'error'; message: string; at: string }[];
}
