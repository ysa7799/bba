import type { Metadata } from 'next';
import { AuthCard } from '@/components/auth/auth-card';
import { Invitation } from '@/components/auth/invitation';
import { Alert } from '@/components/ui/alert';
import { getMessages } from '@/i18n';
import { pickString } from '@/lib/navigation';

export const metadata: Metadata = { title: 'Invitation', referrer: 'no-referrer' };

export default async function InvitePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const m = getMessages('en');
  const token = pickString((await searchParams).token);
  return (
    <AuthCard title={m.auth.invite.title}>
      {token ? <Invitation token={token} /> : <Alert tone="error">{m.auth.missingToken}</Alert>}
    </AuthCard>
  );
}
