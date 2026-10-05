import { EditorPage } from '@/components/commerce/editor-page';

export default async function EditInvoicePage({
  params,
}: {
  params: Promise<{ orgId: string; invoiceId: string }>;
}) {
  const { orgId, invoiceId } = await params;
  return <EditorPage orgId={orgId} kind="invoice" documentId={invoiceId} />;
}
