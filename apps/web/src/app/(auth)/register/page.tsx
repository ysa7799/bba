import type { Metadata } from 'next';
import Link from 'next/link';
import { AuthCard } from '@/components/auth/auth-card';
import { RegisterForm } from '@/components/auth/register-form';
import { getMessages } from '@/i18n';

export const metadata: Metadata = { title: 'Create account' };

export default function RegisterPage() {
  const m = getMessages('en');
  return (
    <AuthCard
      title={m.auth.register.title}
      footer={
        <>
          {m.auth.register.haveAccount}{' '}
          <Link href="/login" className="font-medium text-brand-600 hover:underline">
            {m.auth.login.submit}
          </Link>
        </>
      }
    >
      <RegisterForm />
    </AuthCard>
  );
}
