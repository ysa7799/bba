import { organizationSettings, type TenantTx } from '@businessos/database';
import { ValidationError } from '@businessos/shared';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

/**
 * Registry of organization settings. Each key has a Zod schema and a default; unknown keys
 * are rejected. Settings that need relational querying get their own tables instead.
 */
export const SETTINGS_REGISTRY = {
  /** First day of the week for calendars and reports (0 = Sunday; GCC work week starts Sunday). */
  'general.week_start_day': { schema: z.number().int().min(0).max(6), default: 0 },
  /** First month of the fiscal year (1 = January). */
  'general.fiscal_year_start_month': { schema: z.number().int().min(1).max(12), default: 1 },
  'general.date_format': {
    schema: z.enum(['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD']),
    default: 'DD/MM/YYYY',
  },
} as const satisfies Record<string, { schema: z.ZodType; default: unknown }>;

export type SettingKey = keyof typeof SETTINGS_REGISTRY;
export type SettingValue<K extends SettingKey> = z.infer<(typeof SETTINGS_REGISTRY)[K]['schema']>;
export type OrganizationSettingsMap = { [K in SettingKey]: SettingValue<K> };

export function isSettingKey(key: string): key is SettingKey {
  return Object.hasOwn(SETTINGS_REGISTRY, key);
}

function defaults(): OrganizationSettingsMap {
  const out: Record<string, unknown> = {};
  for (const [key, definition] of Object.entries(SETTINGS_REGISTRY)) {
    out[key] = definition.default;
  }
  return out as OrganizationSettingsMap;
}

/** Returns all settings with defaults applied. Invalid stored values fall back to defaults. */
export async function getOrganizationSettings(
  tx: TenantTx,
  organizationId: string,
): Promise<OrganizationSettingsMap> {
  const rows = await tx
    .select({ key: organizationSettings.key, value: organizationSettings.value })
    .from(organizationSettings)
    .where(eq(organizationSettings.organizationId, organizationId));
  const result: Record<string, unknown> = defaults();
  for (const row of rows) {
    if (!isSettingKey(row.key)) continue;
    const parsed = SETTINGS_REGISTRY[row.key].schema.safeParse(row.value);
    if (parsed.success) result[row.key] = parsed.data;
  }
  return result as OrganizationSettingsMap;
}

/** Validates and upserts a partial settings update. */
export async function updateOrganizationSettings(
  tx: TenantTx,
  organizationId: string,
  patch: Record<string, unknown>,
  actorUserId: string | null,
): Promise<OrganizationSettingsMap> {
  const entries = Object.entries(patch);
  const issues: { path: string; message: string }[] = [];
  const validated: { key: SettingKey; value: unknown }[] = [];
  for (const [key, value] of entries) {
    if (!isSettingKey(key)) {
      issues.push({ path: key, message: 'Unknown setting' });
      continue;
    }
    const parsed = SETTINGS_REGISTRY[key].schema.safeParse(value);
    if (!parsed.success) {
      issues.push({ path: key, message: parsed.error.issues[0]?.message ?? 'Invalid value' });
      continue;
    }
    validated.push({ key, value: parsed.data });
  }
  if (issues.length > 0) {
    throw new ValidationError('Invalid settings', issues);
  }

  for (const { key, value } of validated) {
    await tx
      .insert(organizationSettings)
      .values({ organizationId, key, value, updatedByUserId: actorUserId })
      .onConflictDoUpdate({
        target: [organizationSettings.organizationId, organizationSettings.key],
        set: { value, updatedByUserId: actorUserId, updatedAt: new Date() },
        setWhere: and(eq(organizationSettings.organizationId, organizationId)),
      });
  }
  return getOrganizationSettings(tx, organizationId);
}
