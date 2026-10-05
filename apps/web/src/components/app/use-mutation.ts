'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ApiError } from '@/lib/api-client';

/** Runs a mutation, tracks pending/error state and refreshes server components on success. */
export function useMutation() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  /**
   * `refresh: false` skips re-rendering server components, for callers that navigate away on
   * success (a refresh followed by a navigation aborts the refresh stream).
   */
  async function run(
    action: () => Promise<unknown>,
    options: { refresh?: boolean } = {},
  ): Promise<boolean> {
    setPending(true);
    setError(null);
    try {
      await action();
      if (options.refresh !== false) router.refresh();
      return true;
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught
          : new ApiError(0, 'unknown_error', 'Something went wrong. Please try again.'),
      );
      return false;
    } finally {
      setPending(false);
    }
  }

  return { run, pending, error, reset: () => setError(null) };
}
