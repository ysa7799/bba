import 'server-only';
import type { Assignee, CustomFieldDefinition, TagSummary } from './crm-types';
import { serverGetJson } from './server-api';

/** Tags, active custom fields of one record type and assignable members for CRM forms. */
export async function crmFormOptions(
  orgId: string,
  entityType: 'contact' | 'company' | 'deal',
): Promise<{ tags: TagSummary[]; fields: CustomFieldDefinition[]; assignees: Assignee[] }> {
  const base = `/app/orgs/${orgId}/crm`;
  const [tags, fields, assignees] = await Promise.all([
    serverGetJson<{ data: TagSummary[] }>(`${base}/tags`),
    serverGetJson<{ data: CustomFieldDefinition[] }>(
      `${base}/custom-fields?entityType=${entityType}`,
    ),
    serverGetJson<{ data: Assignee[] }>(`${base}/assignees`),
  ]);
  return { tags: tags?.data ?? [], fields: fields?.data ?? [], assignees: assignees?.data ?? [] };
}

/** Copies allowed, non-empty string query parameters (filters) into a URLSearchParams. */
export function pickFilters(
  query: Record<string, string | string[] | undefined>,
  allowed: readonly string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of allowed) {
    const value = query[key];
    if (typeof value === 'string' && value.trim() !== '' && value.length <= 200)
      out[key] = value.trim();
  }
  return out;
}
