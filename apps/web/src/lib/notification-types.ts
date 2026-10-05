// Response shapes of `/app/orgs/:orgId/notifications` (mirrors `@businessos/notifications`).

export interface NotificationSummary {
  id: string;
  type: string;
  title: string;
  body: string | null;
  /** In-app path (always below `/o/<organizationId>/`). */
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface NotificationPage {
  data: NotificationSummary[];
  nextCursor: string | null;
  unread: number;
}

export interface NotificationPreference {
  type: string;
  inApp: boolean;
  email: boolean;
}
