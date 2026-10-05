import { notFound } from 'next/navigation';
import { AuthCard } from '@/components/auth/auth-card';
import { FakeCheckout } from '@/components/dev/fake-checkout';
import { getMessages } from '@/i18n';
import { pickString } from '@/lib/navigation';

export const dynamic = 'force-dynamic';

/**
 * Hosted-page stand-in for the fake payment provider. Only served when explicitly enabled for
 * development/end-to-end environments (the API refuses the fake provider in production).
 */
export default async function FakeCheckoutPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.ENABLE_DEV_PAYMENTS !== 'true') notFound();
  const query = await searchParams;
  const paymentId = pickString(query.payment);
  const returnUrl = pickString(query.return);
  if (!paymentId || !/^fake_[a-f0-9]{16}$/.test(paymentId) || !returnUrl) notFound();
  let returnPath: string;
  try {
    const parsed = new URL(returnUrl);
    // Only same-site paths: drop whatever origin was supplied.
    if (!parsed.pathname.startsWith('/o/')) notFound();
    returnPath = `${parsed.pathname}${parsed.search}`;
  } catch {
    notFound();
  }
  const m = getMessages('en');
  return (
    <AuthCard title={m.app.devCheckout.title}>
      <p className="mb-4 text-sm text-slate-600">{m.app.devCheckout.body}</p>
      <FakeCheckout paymentId={paymentId} returnPath={returnPath} />
    </AuthCard>
  );
}
