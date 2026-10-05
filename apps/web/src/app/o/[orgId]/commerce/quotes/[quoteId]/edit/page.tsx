import { EditorPage } from '@/components/commerce/editor-page';

export default async function EditQuotePage({
  params,
}: {
  params: Promise<{ orgId: string; quoteId: string }>;
}) {
  const { orgId, quoteId } = await params;
  return <EditorPage orgId={orgId} kind="quote" documentId={quoteId} />;
}
