'use client';

import { Button } from '@/components/ui/button';

export default function RootError({ reset }: { error: Error; reset: () => void }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="text-lg font-semibold">Something went wrong</h1>
      <p className="text-sm text-slate-600">
        We could not load this page. If the problem continues, check the system status.
      </p>
      <Button onClick={reset}>Try again</Button>
    </main>
  );
}
