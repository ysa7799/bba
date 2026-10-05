import type { Metadata } from 'next';
import { AuthCard } from '@/components/auth/auth-card';
import { format, getMessages } from '@/i18n';
import { pickString } from '@/lib/navigation';

export const metadata: Metadata = { title: 'Check your email' };

export default async function CheckEmailPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const m = getMessages('en');
  const email = pickString((await searchParams).email)?.slice(0, 254) ?? '';
  return (
    <AuthCard title={m.auth.checkEmail.title}>
      <p className="text-sm text-slate-700">{format(m.auth.checkEmail.body, { email })}</p>
    </AuthCard>
  );
}
