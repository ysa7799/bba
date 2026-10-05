// Response shapes of `/app/orgs/:orgId/communications/*` used by the inbox UI.

export type Channel = 'email' | 'whatsapp' | 'sms';

export interface ConversationSummary {
  id: string;
  channel: Channel;
  connection: { id: string; name: string; address: string; provider: string };
  contact: { id: string; name: string } | null;
  counterpart: { address: string; name: string | null };
  subject: string | null;
  status: 'open' | 'closed';
  assignee: { userId: string; name: string | null } | null;
  unreadCount: number;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  lastMessageDirection: string | null;
  lastInboundAt: string | null;
  canReplyFreely: boolean;
  tags: { id: string; name: string; color: string }[];
  createdAt: string;
}

export type MessageStatus =
  'received' | 'queued' | 'sending' | 'sent' | 'delivered' | 'read' | 'failed';

export interface MessageSummary {
  id: string;
  direction: 'inbound' | 'outbound' | 'internal';
  status: MessageStatus;
  author: { userId: string; name: string | null } | null;
  subject: string | null;
  text: string;
  template: { name: string; language: string; parameters: string[] } | null;
  errorCode: string | null;
  errorMessage: string | null;
  attachments: {
    id: string;
    fileName: string;
    contentType: string;
    sizeBytes: number | null;
    status: string;
  }[];
  createdAt: string;
  sentAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
}

export type ConnectionStatus = 'active' | 'configuration_required' | 'error' | 'disconnected';

/** What every inbox member sees about a channel. */
export interface ChannelPublic {
  id: string;
  channel: Channel;
  provider: string;
  providerLabel: string;
  name: string;
  address: string;
  status: ConnectionStatus;
}

/** Full channel view (members with `communications.manage`); secrets are never included. */
export interface ChannelDetail extends ChannelPublic {
  externalAccountId: string | null;
  configuredFields: string[];
  publicCredentials: Record<string, string>;
  settings: Record<string, unknown>;
  lastError: string | null;
  lastInboundAt: string | null;
  createdAt: string;
}

export interface ProviderInfo {
  key: string;
  channel: Channel;
  label: string;
  requiresExternalAccountId: boolean;
  credentialFields: { key: string; label: string; secret: boolean; optional?: true }[];
}

export interface TemplateSummary {
  id: string;
  connectionId: string;
  name: string;
  language: string;
  category: 'marketing' | 'utility' | 'authentication';
  body: string;
  variableCount: number;
}
