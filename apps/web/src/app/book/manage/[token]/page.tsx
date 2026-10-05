import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ManageBooking } from '@/components/booking/manage-booking';
import { PublicShell } from '@/components/booking/public-shell';
import type { ManagedAppointment } from '@/lib/calendar-types';
import { serverPublicGetJson } from '@/lib/server-api';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'Your appointment',
  // Manage links are personal: keep them out of search engines and referrers.
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

const TOKEN = /^[A-Za-z0-9_-]{40,60}$/;

export default async function ManageBookingPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  if (!TOKEN.test(token)) notFound();
  const result = await serverPublicGetJson<{ appointment: ManagedAppointment }>(
    `/public/booking/manage/${token}`,
  );
  if (!result) notFound();
  return (
    <PublicShell organization={result.appointment.organization.name}>
      <ManageBooking token={token} appointment={result.appointment} />
    </PublicShell>
  );
}
