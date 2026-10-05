import { redirect } from 'next/navigation';
import { getMe } from '@/lib/server-api';

export const dynamic = 'force-dynamic';

/** Entry point: route visitors to sign-in, onboarding, or their last organization. */
export default async function HomePage() {
  const me = await getMe();
  if (!me) redirect('/login');
  const target = me.activeOrganizationId ?? me.organizations[0]?.id;
  redirect(target ? `/o/${target}` : '/onboarding');
}
