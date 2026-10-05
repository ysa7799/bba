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

export interface RoleRef {
  id: string;
  name: string;
  systemKey: string | null;
}

export interface MemberSummary {
  membershipId: string;
  userId: string;
  name: string;
  email: string;
  status: 'active' | 'suspended';
  joinedAt: string;
  roles: RoleRef[];
}

export interface RoleSummary {
  id: string;
  name: string;
  description: string;
  systemKey: string | null;
  isSystem: boolean;
  permissions: string[];
  memberCount?: number;
}

export interface OrgAccess {
  membershipId: string;
  roles: RoleSummary[];
  permissions: string[];
  isOwner: boolean;
}

export interface PermissionDefinition {
  key: string;
  module: string;
  label: string;
  description: string;
}

export interface PendingInvitation {
  id: string;
  email: string;
  roleId: string;
  roleName: string;
  invitedBy: string | null;
  expiresAt: string;
  createdAt: string;
}

export interface AuditLogEntry {
  id: string;
  action: string;
  actorType: string;
  actorUserId: string | null;
  actorLabel: string | null;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown>;
  ipAddress: string | null;
  requestId: string | null;
  createdAt: string;
}

export interface MoneyJson {
  amount: string;
  currency: string;
}

export interface CatalogPlan {
  id: string;
  key: string;
  name: string;
  description: string;
  isDefault: boolean;
  version: number;
  entitlements: Record<string, boolean | number | null>;
  prices: (MoneyJson & { id: string; interval: 'month' | 'year' })[];
}

export interface EntitlementsResponse {
  entitlements: Record<string, boolean | number | null>;
  sources: Record<string, 'plan' | 'override' | 'fallback'>;
  usage: Record<string, { used: number; limit?: number | null; periodStart?: string }>;
}

export interface BillingCustomer {
  legalName: string;
  billingEmail: string;
  taxId: string | null;
  countryCode: string;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  postalCode: string | null;
}

export interface SubscriptionResponse {
  subscription: {
    id: string;
    status: string;
    provider: string;
    currentPeriodStart: string;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
  } | null;
  plan: CatalogPlan | null;
}

export interface PaymentsConfig {
  provider: string | null;
  status: 'ready' | 'configuration_required' | 'disabled';
  methods: string[];
}

export interface OrganizationSettings {
  'general.week_start_day': number;
  'general.fiscal_year_start_month': number;
  'general.date_format': string;
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
