import { notFound } from 'next/navigation';
import { AuthCard } from '@/components/auth/auth-card';
import { FakeOAuthConsent } from '@/components/integrations/fake-oauth-consent';
import { getMessages } from '@/i18n';
import { pickString } from '@/lib/navigation';

export const dynamic = 'force-dynamic';

/**
 * Consent screen of the fake OAuth provider. Only served when explicitly enabled for
 * development/end-to-end environments (the API refuses the fake provider in production).
 */
export default async function FakeOAuthPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.ENABLE_DEV_INTEGRATIONS !== 'true') notFound();
  const query = await searchParams;
  const state = pickString(query.state);
  const redirectUri = pickString(query.redirect_uri);
  if (!state || !/^[A-Za-z0-9_-]{20,200}$/.test(state) || !redirectUri) notFound();
  try {
    // Only this site's callback: never a redirect to an address in the query.
    if (new URL(redirectUri).pathname !== '/oauth/callback') notFound();
  } catch {
    notFound();
  }
  const m = getMessages('en');
  return (
    <AuthCard title={m.integrations.fakeTitle}>
      <p className="mb-4 text-sm text-slate-600">{m.integrations.fakeIntro}</p>
      <FakeOAuthConsent state={state} />
    </AuthCard>
  );
}
