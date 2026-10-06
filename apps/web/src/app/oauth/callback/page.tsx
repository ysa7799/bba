import { AuthCard } from '@/components/auth/auth-card';
import { OAuthCallback } from '@/components/integrations/oauth-callback';
import { getMessages } from '@/i18n';
import { pickString } from '@/lib/navigation';

export const dynamic = 'force-dynamic';

/**
 * Where providers send people back after they approve (or refuse) a connection. The page posts
 * the provider's answer to the API with the visitor's session; the API checks the state.
 */
export default async function OAuthCallbackPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const m = getMessages('en');
  return (
    <AuthCard title={m.integrations.callbackTitle}>
      <OAuthCallback
        state={pickString(query.state) ?? ''}
        code={pickString(query.code) ?? null}
        error={pickString(query.error) ?? null}
      />
    </AuthCard>
  );
}
