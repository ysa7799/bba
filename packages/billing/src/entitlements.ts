import { z } from 'zod';

/**
 * Entitlement registry. Plans grant values for these keys; code only ever asks about keys,
 * never about plan names. `fallback` applies when an organization has no live subscription
 * (and no override): a deliberately small baseline.
 *
 *  - feature: boolean switch
 *  - limit:   maximum concurrent amount of something (null = unlimited)
 *  - quota:   maximum per calendar month, metered through `usage_counters` (null = unlimited)
 */
export type EntitlementKind = 'feature' | 'limit' | 'quota';

interface Definition {
  kind: EntitlementKind;
  description: string;
  fallback: boolean | number | null;
}

export const ENTITLEMENTS = {
  'users.max': {
    kind: 'limit',
    description: 'Members (including pending invitations)',
    fallback: 3,
  },
  'workspaces.max': { kind: 'limit', description: 'Workspaces / locations', fallback: 1 },
  'crm.contacts.max': { kind: 'limit', description: 'CRM contacts', fallback: 500 },
  'crm.pipelines.max': { kind: 'limit', description: 'Sales pipelines', fallback: 1 },
  'automation.workflows.max': { kind: 'limit', description: 'Active workflows', fallback: 0 },
  'forms.max': { kind: 'limit', description: 'Forms (not archived)', fallback: 3 },
  'automation.monthly_executions': {
    kind: 'quota',
    description: 'Workflow runs per month',
    fallback: 0,
  },
  'email.monthly_limit': {
    kind: 'quota',
    description: 'Marketing/communication emails per month',
    fallback: 200,
  },
  'sms.monthly_limit': { kind: 'quota', description: 'SMS per month', fallback: 0 },
  'whatsapp.monthly_limit': {
    kind: 'quota',
    description: 'WhatsApp messages per month',
    fallback: 0,
  },
  'storage.bytes': { kind: 'limit', description: 'File storage in bytes', fallback: 1_073_741_824 },
  'ai.monthly_credits': { kind: 'quota', description: 'AI credits per month', fallback: 0 },
  'projects.enabled': { kind: 'feature', description: 'Project management', fallback: false },
  'helpdesk.enabled': { kind: 'feature', description: 'Helpdesk', fallback: false },
  'marketing.enabled': { kind: 'feature', description: 'Marketing campaigns', fallback: false },
  'api.enabled': { kind: 'feature', description: 'Public API access', fallback: false },
  'white_label.enabled': { kind: 'feature', description: 'White-label branding', fallback: false },
  'custom_domain.enabled': { kind: 'feature', description: 'Custom domains', fallback: false },
} as const satisfies Record<string, Definition>;

export type EntitlementKey = keyof typeof ENTITLEMENTS;
export type FeatureKey = {
  [K in EntitlementKey]: (typeof ENTITLEMENTS)[K]['kind'] extends 'feature' ? K : never;
}[EntitlementKey];
export type LimitKey = Exclude<EntitlementKey, FeatureKey>;
export type QuotaKey = {
  [K in EntitlementKey]: (typeof ENTITLEMENTS)[K]['kind'] extends 'quota' ? K : never;
}[EntitlementKey];

export type EntitlementValue = boolean | number | null;

export function isEntitlementKey(value: string): value is EntitlementKey {
  return Object.hasOwn(ENTITLEMENTS, value);
}

const featureValue = z.boolean();
const limitValue = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable();

/** Validates a stored/admin-provided value for a key; throws on mismatch. */
export function parseEntitlementValue(key: EntitlementKey, value: unknown): EntitlementValue {
  return ENTITLEMENTS[key].kind === 'feature' ? featureValue.parse(value) : limitValue.parse(value);
}

/**
 * Stored representation: `{ "value": … }`. A JSON envelope keeps `null` (unlimited) distinct
 * from SQL NULL, which drivers produce for a bare JS null.
 */
export function encodeEntitlementValue(value: EntitlementValue): { value: EntitlementValue } {
  return { value };
}

export function decodeEntitlementValue(key: EntitlementKey, stored: unknown): EntitlementValue {
  if (stored === null || typeof stored !== 'object' || !('value' in stored)) {
    throw new Error('Malformed stored entitlement value');
  }
  return parseEntitlementValue(key, stored.value);
}

export function fallbackEntitlements(): Record<EntitlementKey, EntitlementValue> {
  const out = {} as Record<EntitlementKey, EntitlementValue>;
  for (const key of Object.keys(ENTITLEMENTS) as EntitlementKey[]) {
    out[key] = ENTITLEMENTS[key].fallback;
  }
  return out;
}
