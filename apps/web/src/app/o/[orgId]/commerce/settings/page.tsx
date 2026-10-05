import { notFound } from 'next/navigation';
import { OrgAccessBoundary } from '@/components/app/org-access-boundary';
import {
  NumberingForm,
  PaymentConnectionPanel,
  TaxRatesPanel,
} from '@/components/commerce/settings-panels';
import { CrmForbidden } from '@/components/crm/crm-forbidden';
import { Section } from '@/components/crm/detail';
import { PageHeader } from '@/components/ui/card';
import { getMessages } from '@/i18n';
import type {
  CommerceSettings,
  CredentialField,
  PaymentConnection,
  TaxRate,
} from '@/lib/commerce-types';
import { getOrgAccess } from '@/lib/org-data';
import { serverGetJson } from '@/lib/server-api';

export default async function CommerceSettingsPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  const m = getMessages('en');
  const access = await getOrgAccess(orgId);
  if (!access) notFound();
  if (!access.permissions.includes('commerce.invoice.read')) {
    return <CrmForbidden title={m.commerce.settings} message={m.commerce.forbidden} />;
  }
  const api = `/app/orgs/${orgId}/commerce`;
  const canManageSettings = access.permissions.includes('commerce.settings.manage');
  const [settings, taxRates, payments] = await Promise.all([
    serverGetJson<{ settings: CommerceSettings; onlinePayments: boolean }>(`${api}/settings`),
    serverGetJson<{ data: TaxRate[] }>(`${api}/tax-rates?includeArchived=true`),
    canManageSettings
      ? serverGetJson<{
          connection: PaymentConnection | null;
          providers: { name: string; label: string; credentialFields: CredentialField[] }[];
          credentialStorage: boolean;
        }>(`${api}/payment-connection`)
      : Promise.resolve(null),
  ]);
  if (!settings || !taxRates) notFound();

  return (
    <OrgAccessBoundary orgId={orgId}>
      <PageHeader title={m.commerce.settings} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Section title={m.commerce.onlinePayments}>
          {payments ? (
            <PaymentConnectionPanel
              connection={payments.connection}
              providers={payments.providers}
              credentialStorage={payments.credentialStorage}
            />
          ) : (
            <p className="text-sm text-slate-600">
              {settings.onlinePayments
                ? m.commerce.connectionStatus.active
                : m.commerce.noOnlinePayments}
            </p>
          )}
        </Section>
        <Section title={m.commerce.taxRates}>
          <TaxRatesPanel taxRates={taxRates.data} />
        </Section>
        <Section title={m.commerce.numbering}>
          <NumberingForm settings={settings.settings} />
        </Section>
      </div>
    </OrgAccessBoundary>
  );
}
