import { EditorPage } from '@/components/commerce/editor-page';
import { pickString } from '@/lib/navigation';

export default async function NewInvoicePage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { orgId } = await params;
  const query = await searchParams;
  return <EditorPage orgId={orgId} kind="invoice" contactId={pickString(query.contactId)} />;
}
