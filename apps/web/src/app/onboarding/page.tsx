import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { CreateOrganizationForm } from '@/components/app/create-organization-form';
import { AuthCard } from '@/components/auth/auth-card';
import { getMessages } from '@/i18n';
import { getMe } from '@/lib/server-api';

export const metadata: Metadata = { title: 'Create organization' };
export const dynamic = 'force-dynamic';

export default async function OnboardingPage() {
  const me = await getMe();
  if (!me) redirect('/login?next=/onboarding');
  const m = getMessages(me.user.locale);
  return (
    <AuthCard title={m.onboarding.title}>
      <p className="mb-4 text-sm text-slate-600">{m.onboarding.subtitle}</p>
      <CreateOrganizationForm />
    </AuthCard>
  );
}
