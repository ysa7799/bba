// Response shapes of the first-party API used by the web app.

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: { path: string; message: string }[];
    requestId: string;
  };
}

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  locale: string;
  timezone: string;
}

export interface OrganizationSummary {
  id: string;
  name: string;
  slug: string;
  countryCode: string;
  defaultCurrency: string;
  timezone: string;
  locale: string;
  status: 'active' | 'suspended' | 'cancelled';
  createdAt: string;
}

export interface Me {
  user: SessionUser;
  organizations: OrganizationSummary[];
  activeOrganizationId: string | null;
}

export interface MemberSummary {
  membershipId: string;
  userId: string;
  name: string;
  email: string;
  status: 'active' | 'suspended';
  joinedAt: string;
}

export interface Page<T> {
  data: T[];
  nextCursor: string | null;
}

export interface InvitationPreview {
  organizationName: string;
  email: string;
  inviterName: string | null;
  expiresAt: string;
  accountExists: boolean;
}
