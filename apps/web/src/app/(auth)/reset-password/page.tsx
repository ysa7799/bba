import type { Metadata } from 'next';
import { AuthCard } from '@/components/auth/auth-card';
import { ResetPasswordForm } from '@/components/auth/reset-password-form';
import { Alert } from '@/components/ui/alert';
import { getMessages } from '@/i18n';
import { pickString } from '@/lib/navigation';

export const metadata: Metadata = { title: 'Choose a new password', referrer: 'no-referrer' };

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const m = getMessages('en');
  const token = pickString((await searchParams).token);
  return (
    <AuthCard title={m.auth.reset.title}>
      {token ? (
        <ResetPasswordForm token={token} />
      ) : (
        <Alert tone="error">{m.auth.missingToken}</Alert>
      )}
    </AuthCard>
  );
}
