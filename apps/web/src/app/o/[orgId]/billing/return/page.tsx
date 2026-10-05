import { CheckoutReturn } from '@/components/app/checkout-return';
import { Alert } from '@/components/ui/alert';
import { PageHeader } from '@/components/ui/card';
import { getMessages } from '@/i18n';
import { pickString } from '@/lib/navigation';

export default async function CheckoutReturnPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { orgId } = await params;
  const checkoutId = pickString((await searchParams).checkout);
  const m = getMessages('en');
  return (
    <>
      <PageHeader title={m.app.billing.returnTitle} />
      {checkoutId && /^[0-9a-f-]{36}$/.test(checkoutId) ? (
        <CheckoutReturn organizationId={orgId} checkoutId={checkoutId} />
      ) : (
        <Alert tone="error">{m.auth.missingToken}</Alert>
      )}
    </>
  );
}
