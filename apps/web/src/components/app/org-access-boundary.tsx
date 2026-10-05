import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { getOrgAccess } from '@/lib/org-data';
import { OrgAccessProvider } from './org-access';

/** Provides fresh per-request access data to client components of a tenant page. */
export async function OrgAccessBoundary({
  orgId,
  children,
}: {
  orgId: string;
  children: ReactNode;
}) {
  const access = await getOrgAccess(orgId);
  if (!access) notFound();
  return (
    <OrgAccessProvider organizationId={orgId} access={access}>
      {children}
    </OrgAccessProvider>
  );
}
