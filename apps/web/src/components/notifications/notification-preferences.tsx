'use client';

import { useState, type SubmitEvent } from 'react';
import { useOrg } from '@/components/app/org-access';
import { useMutation } from '@/components/app/use-mutation';
import { useMessages } from '@/components/i18n-provider';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { apiRequest } from '@/lib/api-client';
import type { NotificationPreference } from '@/lib/notification-types';

/** In-app and email choices per notification type (only types the member can receive). */
export function NotificationPreferencesForm({ initial }: { initial: NotificationPreference[] }) {
  const m = useMessages();
  const { organizationId } = useOrg();
  const [preferences, setPreferences] = useState(initial);
  const [saved, setSaved] = useState(false);
  const { run, pending, error } = useMutation();
  const labels: Record<string, string> = m.notifications.types;

  function toggle(type: string, channel: 'inApp' | 'email', value: boolean) {
    setSaved(false);
    setPreferences((current) =>
      current.map((entry) => (entry.type === type ? { ...entry, [channel]: value } : entry)),
    );
  }

  async function save(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaved(false);
    const ok = await run(
      async () => {
        const result = await apiRequest<{ preferences: NotificationPreference[] }>(
          `/app/orgs/${organizationId}/notifications/preferences`,
          { method: 'PUT', body: { preferences } },
        );
        setPreferences(result.preferences);
      },
      { refresh: false },
    );
    setSaved(ok);
  }

  return (
    <Card className="p-4">
      <h2 className="text-sm font-semibold text-slate-900">{m.notifications.preferences}</h2>
      <p className="mb-3 mt-1 text-xs text-slate-500">{m.notifications.preferencesHint}</p>
      {preferences.length === 0 ? (
        <p className="text-sm text-slate-500">{m.notifications.preferencesEmpty}</p>
      ) : (
        <form onSubmit={(event) => void save(event)} className="space-y-3">
          {error ? <Alert tone="error">{error.message}</Alert> : null}
          {saved ? <Alert tone="success">{m.notifications.saved}</Alert> : null}
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-slate-500">
                <th scope="col" className="pb-2 text-start font-medium">
                  {m.notifications.type}
                </th>
                <th scope="col" className="w-16 pb-2 text-center font-medium">
                  {m.notifications.inApp}
                </th>
                <th scope="col" className="w-16 pb-2 text-center font-medium">
                  {m.notifications.email}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {preferences.map((entry) => {
                const label = labels[entry.type] ?? entry.type;
                return (
                  <tr key={entry.type}>
                    <th scope="row" className="py-2 pe-2 text-start font-normal text-slate-800">
                      {label}
                    </th>
                    <td className="py-2 text-center">
                      <input
                        type="checkbox"
                        aria-label={`${label}: ${m.notifications.inApp}`}
                        className="h-4 w-4 rounded border-slate-300"
                        checked={entry.inApp}
                        onChange={(event) => toggle(entry.type, 'inApp', event.target.checked)}
                      />
                    </td>
                    <td className="py-2 text-center">
                      <input
                        type="checkbox"
                        aria-label={`${label}: ${m.notifications.email}`}
                        className="h-4 w-4 rounded border-slate-300"
                        checked={entry.email}
                        onChange={(event) => toggle(entry.type, 'email', event.target.checked)}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="flex justify-end">
            <Button type="submit" size="sm" loading={pending}>
              {m.notifications.savePreferences}
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}
