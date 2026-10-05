import { Alert } from '@/components/ui/alert';
import { PageHeader } from '@/components/ui/card';
import { getMessages } from '@/i18n';

export function CrmForbidden({ title, message }: { title: string; message?: string }) {
  const m = getMessages('en');
  return (
    <>
      <PageHeader title={title} />
      <Alert tone="info">{message ?? m.crm.forbidden}</Alert>
    </>
  );
}
