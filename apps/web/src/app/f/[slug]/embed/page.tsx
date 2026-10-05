import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { PublicForm } from '@/components/forms/public-form';
import { hiddenPrefill, loadPublicForm } from '@/lib/public-form';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { robots: { index: false } };

/**
 * Embeddable form (inside an iframe on the organization's website). Which sites may frame it
 * is decided per form by `src/proxy.ts` (CSP `frame-ancestors`).
 */
export default async function EmbeddedFormPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const view = await loadPublicForm(slug);
  if (!view) notFound();
  return (
    <main className="bg-white p-4">
      <h1 className="text-lg font-semibold text-slate-900">{view.form.title}</h1>
      {view.form.description ? (
        <p className="mt-1 whitespace-pre-wrap text-sm text-slate-600">{view.form.description}</p>
      ) : null}
      <div className="mt-4">
        <PublicForm
          slug={view.form.slug}
          view={view}
          embed
          prefill={hiddenPrefill(view, await searchParams)}
        />
      </div>
    </main>
  );
}
