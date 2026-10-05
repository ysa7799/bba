import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getMessages } from '@/i18n';
import { PublicShell } from '@/components/booking/public-shell';
import { PublicForm } from '@/components/forms/public-form';
import { hiddenPrefill, loadPublicForm } from '@/lib/public-form';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const view = await loadPublicForm((await params).slug);
  return view ? { title: `${view.form.title} · ${view.organization.name}` } : {};
}

/** Public form page (no account needed). */
export default async function PublicFormPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const view = await loadPublicForm(slug);
  if (!view) notFound();
  const m = getMessages('en');
  return (
    <PublicShell organization={view.organization.name} poweredBy={m.forms.public.poweredBy}>
      <h1 className="text-xl font-semibold text-slate-900">{view.form.title}</h1>
      {view.form.description ? (
        <p className="mt-1 whitespace-pre-wrap text-sm text-slate-600">{view.form.description}</p>
      ) : null}
      <div className="mt-6">
        <PublicForm
          slug={view.form.slug}
          view={view}
          embed={false}
          prefill={hiddenPrefill(view, await searchParams)}
        />
      </div>
    </PublicShell>
  );
}
