'use client';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

export default function OrganizationError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="max-w-lg space-y-4">
      <Alert tone="error">This page could not be loaded.</Alert>
      <Button variant="secondary" onClick={reset}>
        Try again
      </Button>
    </div>
  );
}
