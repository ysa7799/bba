import Link from 'next/link';

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center gap-6 px-6">
      <h1 className="text-3xl font-semibold tracking-tight">BusinessOS</h1>
      <p className="text-slate-600">
        One account for customers, sales, communications, scheduling, invoicing and operations.
      </p>
      <div>
        <Link
          href="/status"
          className="text-sm font-medium text-brand-600 underline-offset-4 hover:underline"
        >
          System status
        </Link>
      </div>
    </main>
  );
}
