import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { AuthCard } from '@/components/auth/auth-card';
import { LoginForm } from '@/components/auth/login-form';
import { getMessages } from '@/i18n';
import { safeNextPath } from '@/lib/navigation';
import { getMe } from '@/lib/server-api';

export const metadata: Metadata = { title: 'Sign in' };
export const dynamic = 'force-dynamic';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const next = safeNextPath((await searchParams).next);
  const me = await getMe();
  if (me) redirect(next ?? '/');
  const m = getMessages('en');
  return (
    <AuthCard
      title={m.auth.login.title}
      footer={
        <>
          {m.auth.login.noAccount}{' '}
          <Link href="/register" className="font-medium text-brand-600 hover:underline">
            {m.auth.login.createAccount}
          </Link>
        </>
      }
    >
      <LoginForm next={next} />
    </AuthCard>
  );
}
