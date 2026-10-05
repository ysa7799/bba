import 'server-only';
import { cache } from 'react';
import type { OrgAccess } from './api-types';
import { serverGetJson } from './server-api';

/**
 * The caller's access in an organization, fetched once per request. Pages (not the layout)
 * call this: layouts are not re-rendered on client navigation, so permissions fetched there
 * would go stale after a role change.
 */
export const getOrgAccess = cache((orgId: string): Promise<OrgAccess | null> =>
  serverGetJson<OrgAccess>(`/app/orgs/${orgId}/access`),
);
