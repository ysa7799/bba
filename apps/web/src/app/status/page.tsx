import type { Metadata } from 'next';
import { serverApiFetch } from '@/lib/server-api';

export const metadata: Metadata = { title: 'System status' };
export const dynamic = 'force-dynamic';

type CheckState = 'ok' | 'fail';
interface Readiness {
  status: 'ok' | 'unavailable';
  checks: { database: CheckState; redis: CheckState };
}

async function loadReadiness(): Promise<Readiness | null> {
  try {
    const response = await serverApiFetch('/health/ready', { signal: AbortSignal.timeout(3_000) });
    return (await response.json()) as Readiness;
  } catch {
    return null;
  }
}

function Row({ label, ok }: { label: string; ok: boolean }) {
  return (
    <li className="flex items-center justify-between rounded-md border border-slate-200 bg-white px-4 py-3">
      <span className="text-sm font-medium">{label}</span>
      <span
        className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
          ok ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-800'
        }`}
      >
        {ok ? 'Operational' : 'Unavailable'}
      </span>
    </li>
  );
}

export default async function StatusPage() {
  const readiness = await loadReadiness();
  return (
    <main className="mx-auto max-w-xl px-6 py-16">
      <h1 className="mb-6 text-2xl font-semibold">System status</h1>
      {readiness === null ? (
        <p
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-800"
        >
          The API could not be reached.
        </p>
      ) : (
        <ul className="space-y-2">
          <Row label="API" ok />
          <Row label="Database" ok={readiness.checks.database === 'ok'} />
          <Row label="Queue / cache" ok={readiness.checks.redis === 'ok'} />
        </ul>
      )}
    </main>
  );
}
