import { Alert } from '@/components/ui/alert';
import { PageHeader } from '@/components/ui/card';
import { getMessages } from '@/i18n';

export function CrmForbidden({ title }: { title: string }) {
  const m = getMessages('en');
  return (
    <>
      <PageHeader title={title} />
      <Alert tone="info">{m.crm.forbidden}</Alert>
    </>
  );
}
