import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { BookingFlow } from '@/components/booking/booking-flow';
import { PublicShell } from '@/components/booking/public-shell';
import type { PublicBookingPage } from '@/lib/calendar-types';
import { serverPublicGetJson } from '@/lib/server-api';

export const dynamic = 'force-dynamic';

const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,62}[a-z0-9])$/;

async function load(slug: string): Promise<PublicBookingPage | null> {
  if (!SLUG.test(slug)) return null;
  return serverPublicGetJson<PublicBookingPage>(`/public/booking/pages/${slug}`);
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const page = await load((await params).slug);
  return page ? { title: `${page.page.title} · ${page.organization.name}` } : {};
}

/** Public booking page (no account needed). */
export default async function BookingPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const page = await load(slug);
  if (!page || page.appointmentTypes.length === 0) notFound();
  return (
    <PublicShell organization={page.organization.name}>
      <h1 className="text-xl font-semibold text-slate-900">{page.page.title}</h1>
      {page.page.description ? (
        <p className="mt-1 whitespace-pre-wrap text-sm text-slate-600">{page.page.description}</p>
      ) : null}
      <BookingFlow slug={page.page.slug} page={page} />
    </PublicShell>
  );
}
