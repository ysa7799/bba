'use client';

import { createContext, useContext, type ReactNode } from 'react';
import type { OrgAccess } from '@/lib/api-types';

interface OrgContextValue {
  organizationId: string;
  access: OrgAccess;
}

const OrgContext = createContext<OrgContextValue | null>(null);

export function OrgAccessProvider({
  organizationId,
  access,
  children,
}: OrgContextValue & { children: ReactNode }) {
  return <OrgContext.Provider value={{ organizationId, access }}>{children}</OrgContext.Provider>;
}

export function useOrg(): OrgContextValue {
  const value = useContext(OrgContext);
  if (!value) throw new Error('useOrg must be used inside OrgAccessProvider');
  return value;
}

/**
 * UI-only permission check used to hide controls. The API enforces every permission
 * server-side regardless of what the UI shows.
 */
export function useCan(permission: string): boolean {
  return useOrg().access.permissions.includes(permission);
}
