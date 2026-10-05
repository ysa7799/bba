'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type SubmitEvent } from 'react';
import { format } from '@/i18n';
import { useMessages } from '@/components/i18n-provider';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { TextField } from '@/components/ui/field';
import { Spinner } from '@/components/ui/spinner';
import { apiRequest, ApiError } from '@/lib/api-client';
import type { InvitationPreview, Me } from '@/lib/api-types';

type Load =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; invitation: InvitationPreview; me: Me | null };

export function Invitation({ token }: { token: string }) {
  const m = useMessages();
  const router = useRouter();
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [form, setForm] = useState({ name: '', password: '' });
  const [error, setError] = useState<ApiError | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      apiRequest<{ invitation: InvitationPreview }>('/app/invitations/preview', {
        body: { token },
      }),
      apiRequest<Me>('/app/me').catch(() => null),
    ])
      .then(([preview, me]) => {
        if (!cancelled) setLoad({ status: 'ready', invitation: preview.invitation, me });
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setLoad({
            status: 'error',
            message: caught instanceof ApiError ? caught.message : m.common.genericError,
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [token, m.common.genericError]);

  async function run(action: () => Promise<{ organizationId: string }>) {
    setPending(true);
    setError(null);
    try {
      const { organizationId } = await action();
      router.replace(`/o/${organizationId}`);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught : null);
      setPending(false);
    }
  }

  if (load.status === 'loading') {
    return (
      <p className="flex items-center gap-2 text-sm text-slate-600" role="status">
        <Spinner className="size-4" /> {m.common.loading}
      </p>
    );
  }
  if (load.status === 'error') return <Alert tone="error">{load.message}</Alert>;

  const { invitation, me } = load;
  const intro = invitation.inviterName
    ? format(m.auth.invite.body, {
        inviter: invitation.inviterName,
        email: invitation.email,
        organization: invitation.organizationName,
      })
    : format(m.auth.invite.bodyNoInviter, {
        email: invitation.email,
        organization: invitation.organizationName,
      });

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-700">{intro}</p>
      {error && error.code !== 'validation_error' ? (
        <Alert tone="error">{error.message}</Alert>
      ) : null}

      {me?.user.email === invitation.email ? (
        <Button
          className="w-full"
          loading={pending}
          onClick={() =>
            run(() =>
              apiRequest<{ organizationId: string }>('/app/invitations/accept', {
                body: { token },
              }),
            )
          }
        >
          {m.auth.invite.accept}
        </Button>
      ) : me ? (
        <Alert tone="info">
          {format(m.auth.invite.wrongAccount, { current: me.user.email, email: invitation.email })}
        </Alert>
      ) : invitation.accountExists ? (
        <Link
          href={`/login?next=${encodeURIComponent(`/invite?token=${token}`)}`}
          className="inline-flex h-10 w-full items-center justify-center rounded-md bg-brand-600 px-4 text-sm font-medium text-white hover:bg-brand-700"
        >
          {format(m.auth.invite.signInToAccept, { email: invitation.email })}
        </Link>
      ) : (
        <form
          className="space-y-4"
          noValidate
          onSubmit={(event: SubmitEvent<HTMLFormElement>) => {
            event.preventDefault();
            void run(() =>
              apiRequest<{ organizationId: string }>('/app/invitations/register', {
                body: { token, ...form },
              }),
            );
          }}
        >
          <TextField label={m.auth.email} value={invitation.email} readOnly disabled />
          <TextField
            label={m.auth.name}
            autoComplete="name"
            required
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
            error={error?.fieldError('name')}
          />
          <TextField
            label={m.auth.password}
            type="password"
            autoComplete="new-password"
            required
            value={form.password}
            onChange={(event) => setForm({ ...form, password: event.target.value })}
            hint={m.auth.register.passwordHint}
            error={error?.fieldError('password')}
          />
          <Button type="submit" className="w-full" loading={pending}>
            {m.auth.invite.createAndJoin}
          </Button>
        </form>
      )}
    </div>
  );
}
