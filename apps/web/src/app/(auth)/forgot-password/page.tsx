import type { Metadata } from 'next';
import Link from 'next/link';
import { AuthCard } from '@/components/auth/auth-card';
import { ForgotPasswordForm } from '@/components/auth/forgot-password-form';
import { getMessages } from '@/i18n';

export const metadata: Metadata = { title: 'Reset password' };

export default function ForgotPasswordPage() {
  const m = getMessages('en');
  return (
    <AuthCard
      title={m.auth.forgot.title}
      footer={
        <Link href="/login" className="font-medium text-brand-600 hover:underline">
          {m.auth.login.submit}
        </Link>
      }
    >
      <ForgotPasswordForm />
    </AuthCard>
  );
}
