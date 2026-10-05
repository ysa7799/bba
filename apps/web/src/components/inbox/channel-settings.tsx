'use client';

import { useState, type SubmitEvent } from 'react';
import { useOrg } from '@/components/app/org-access';
import { useMutation } from '@/components/app/use-mutation';
import { useMessages } from '@/components/i18n-provider';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, EmptyState, PageHeader } from '@/components/ui/card';
import { ConfirmDialog, Dialog } from '@/components/ui/dialog';
import { inputClass, SelectField, TextAreaField, TextField } from '@/components/ui/field';
import { apiRequest } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { formatDateTime } from '@/lib/format';
import type {
  ChannelDetail,
  ConnectionStatus,
  ProviderInfo,
  TemplateSummary,
} from '@/lib/inbox-types';
import { ChannelBadge } from './channel-badge';

const STATUS_STYLES: Record<ConnectionStatus, string> = {
  active: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  configuration_required: 'bg-amber-50 text-amber-800 ring-amber-200',
  error: 'bg-red-50 text-red-700 ring-red-200',
  disconnected: 'bg-slate-100 text-slate-600 ring-slate-200',
};

/**
 * Channel management (`communications.manage`): connect providers with write-only credentials,
 * show a new webhook URL once, rotate it, disconnect, and register WhatsApp templates.
 */
export function ChannelSettings({
  channels,
  providers,
  encryptionConfigured,
  templates,
  timezone,
}: {
  channels: ChannelDetail[];
  providers: ProviderInfo[];
  encryptionConfigured: boolean;
  templates: TemplateSummary[];
  timezone: string;
}) {
  const m = useMessages();
  const [connecting, setConnecting] = useState(false);
  // A webhook URL is shown once, right after it was created or rotated.
  const [revealed, setRevealed] = useState<{ id: string; url: string } | null>(null);
  const live = channels.filter((channel) => channel.status !== 'disconnected');
  const disconnected = channels.filter((channel) => channel.status === 'disconnected');

  return (
    <>
      <PageHeader
        title={m.inbox.channelsTitle}
        actions={<Button onClick={() => setConnecting(true)}>{m.inbox.connect}</Button>}
      />
      {encryptionConfigured ? null : (
        <div className="mb-4">
          <Alert tone="error">{m.inbox.encryptionMissing}</Alert>
        </div>
      )}
      <ConnectDialog
        open={connecting}
        providers={providers}
        encryptionConfigured={encryptionConfigured}
        onClose={() => setConnecting(false)}
        onCreated={(id, url) => {
          setConnecting(false);
          setRevealed({ id, url });
        }}
      />
      {live.length === 0 ? (
        <EmptyState title={m.inbox.noConnected} />
      ) : (
        <ul className="space-y-4" aria-label={m.inbox.connectedChannels}>
          {live.map((channel) => (
            <ChannelCard
              key={channel.id}
              channel={channel}
              provider={providers.find((provider) => provider.key === channel.provider) ?? null}
              templates={templates.filter((template) => template.connectionId === channel.id)}
              webhookUrl={revealed?.id === channel.id ? revealed.url : null}
              onRotated={(url) => setRevealed({ id: channel.id, url })}
              timezone={timezone}
            />
          ))}
        </ul>
      )}
      {disconnected.length > 0 ? (
        <ul className="mt-6 space-y-1 text-sm text-slate-500">
          {disconnected.map((channel) => (
            <li key={channel.id}>
              {channel.name} · {channel.address} · {m.inbox.connectionStatus.disconnected}
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

function StatusBadge({ status }: { status: ConnectionStatus }) {
  const m = useMessages();
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
        STATUS_STYLES[status],
      )}
    >
      {m.inbox.connectionStatus[status]}
    </span>
  );
}

function WebhookNotice({ url }: { url: string }) {
  const m = useMessages();
  return (
    <Alert tone="success">
      <p className="font-medium">{m.inbox.webhookUrl}</p>
      <input
        readOnly
        aria-label={m.inbox.webhookUrl}
        value={url}
        onFocus={(event) => event.target.select()}
        className={cn(inputClass, 'my-2 font-mono text-xs')}
      />
      <p>{m.inbox.webhookShownOnce}</p>
    </Alert>
  );
}

function CredentialInputs({
  provider,
  values,
  onChange,
  channel,
}: {
  provider: ProviderInfo;
  values: Record<string, string>;
  onChange: (values: Record<string, string>) => void;
  /** When editing: which fields already hold a stored value. */
  channel?: ChannelDetail;
}) {
  const m = useMessages();
  if (provider.credentialFields.length === 0) return null;
  return (
    <fieldset className="space-y-3">
      <legend className="text-sm font-medium text-slate-800">{m.inbox.credentials}</legend>
      <p className="text-xs text-slate-500">{m.inbox.credentialsHint}</p>
      {provider.credentialFields.map((field) => {
        const stored = channel?.configuredFields.includes(field.key) ?? false;
        return (
          <TextField
            key={field.key}
            label={field.label}
            type={field.secret ? 'password' : 'text'}
            autoComplete="off"
            maxLength={2_000}
            value={values[field.key] ?? ''}
            placeholder={
              channel && field.secret
                ? stored
                  ? m.inbox.secretSet
                  : m.inbox.secretNotSet
                : (channel?.publicCredentials[field.key] ?? '')
            }
            hint={channel && stored && field.secret ? m.inbox.replaceSecret : undefined}
            onChange={(event) => onChange({ ...values, [field.key]: event.target.value })}
          />
        );
      })}
    </fieldset>
  );
}

/** Drops empty values: an empty field means "not provided" (or "keep the stored value"). */
function filled(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value.trim() !== ''));
}

function ConnectDialog({
  open,
  providers,
  encryptionConfigured,
  onClose,
  onCreated,
}: {
  open: boolean;
  providers: ProviderInfo[];
  encryptionConfigured: boolean;
  onClose: () => void;
  onCreated: (id: string, webhookUrl: string) => void;
}) {
  const m = useMessages();
  const { organizationId } = useOrg();
  const { run, pending, error, reset } = useMutation();
  const [providerKey, setProviderKey] = useState(providers[0]?.key ?? '');
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [externalAccountId, setExternalAccountId] = useState('');
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const provider = providers.find((entry) => entry.key === providerKey) ?? null;

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const created: { result: { connection: { id: string }; webhookUrl: string } | null } = {
      result: null,
    };
    const ok = await run(async () => {
      created.result = await apiRequest(`/app/orgs/${organizationId}/communications/channels`, {
        body: {
          provider: providerKey,
          name,
          address,
          ...(externalAccountId.trim() ? { externalAccountId: externalAccountId.trim() } : {}),
          credentials: encryptionConfigured ? filled(credentials) : {},
        },
      });
    });
    const result = created.result;
    if (ok && result) {
      setName('');
      setAddress('');
      setExternalAccountId('');
      setCredentials({});
      onCreated(result.connection.id, result.webhookUrl);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title={m.inbox.connectTitle}
    >
      <form onSubmit={submit} className="space-y-3">
        {error ? <Alert tone="error">{error.message}</Alert> : null}
        <SelectField
          label={m.inbox.provider}
          value={providerKey}
          onChange={(event) => {
            setProviderKey(event.target.value);
            setCredentials({});
          }}
        >
          {providers.map((entry) => (
            <option key={entry.key} value={entry.key}>
              {entry.label} ({m.inbox.channels[entry.channel]})
            </option>
          ))}
        </SelectField>
        <TextField
          label={m.inbox.channelName}
          required
          maxLength={100}
          value={name}
          error={error?.fieldError('name')}
          onChange={(event) => setName(event.target.value)}
        />
        <TextField
          label={m.inbox.address}
          required
          maxLength={320}
          value={address}
          hint={m.inbox.addressHint}
          error={error?.fieldError('address')}
          onChange={(event) => setAddress(event.target.value)}
        />
        {provider?.requiresExternalAccountId ? (
          <TextField
            label={m.inbox.externalAccountId}
            required
            maxLength={100}
            value={externalAccountId}
            error={error?.fieldError('externalAccountId')}
            onChange={(event) => setExternalAccountId(event.target.value)}
          />
        ) : null}
        {provider && encryptionConfigured ? (
          <CredentialInputs provider={provider} values={credentials} onChange={setCredentials} />
        ) : null}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onClose}>
            {m.common.cancel}
          </Button>
          <Button type="submit" loading={pending}>
            {m.inbox.connect}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function ChannelCard({
  channel,
  provider,
  templates,
  webhookUrl,
  onRotated,
  timezone,
}: {
  channel: ChannelDetail;
  provider: ProviderInfo | null;
  templates: TemplateSummary[];
  webhookUrl: string | null;
  onRotated: (url: string) => void;
  timezone: string;
}) {
  const m = useMessages();
  const { organizationId } = useOrg();
  const { run, pending, error } = useMutation();
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState<'rotate' | 'disconnect' | null>(null);
  const path = `/app/orgs/${organizationId}/communications/channels/${channel.id}`;

  async function rotate() {
    const rotated: { url: string | null } = { url: null };
    const ok = await run(async () => {
      rotated.url = (
        await apiRequest<{ webhookUrl: string }>(`${path}/rotate-webhook`, { body: {} })
      ).webhookUrl;
    });
    setConfirm(null);
    if (ok && rotated.url) onRotated(rotated.url);
  }

  return (
    <li>
      <Card className="space-y-4 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="flex flex-wrap items-center gap-2 text-base font-semibold text-slate-900">
              {channel.name}
              <ChannelBadge channel={channel.channel} />
              <StatusBadge status={channel.status} />
            </h2>
            <p className="text-sm text-slate-600">
              {channel.providerLabel} · {channel.address}
              {channel.externalAccountId ? ` · ${channel.externalAccountId}` : ''}
            </p>
            {channel.lastInboundAt ? (
              <p className="text-xs text-slate-500">
                {m.inbox.lastInbound}: {formatDateTime(channel.lastInboundAt, timezone)}
              </p>
            ) : null}
            {channel.lastError ? (
              <p className="text-xs text-red-600">
                {m.inbox.lastError}: {channel.lastError}
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
              {m.inbox.editChannel}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setConfirm('rotate')}>
              {m.inbox.rotateWebhook}
            </Button>
            <Button size="sm" variant="danger" onClick={() => setConfirm('disconnect')}>
              {m.inbox.disconnect}
            </Button>
          </div>
        </div>
        {error ? <Alert tone="error">{error.message}</Alert> : null}
        {webhookUrl ? <WebhookNotice url={webhookUrl} /> : null}
        {provider ? (
          <EditChannelDialog
            open={editing}
            channel={channel}
            provider={provider}
            onClose={() => setEditing(false)}
          />
        ) : null}
        <ConfirmDialog
          open={confirm === 'rotate'}
          title={m.inbox.rotateWebhook}
          message={m.inbox.rotateConfirm}
          confirmLabel={m.inbox.rotateWebhook}
          cancelLabel={m.common.cancel}
          pending={pending}
          error={null}
          onConfirm={() => void rotate()}
          onClose={() => setConfirm(null)}
        />
        <ConfirmDialog
          open={confirm === 'disconnect'}
          title={m.inbox.disconnect}
          message={m.inbox.disconnectConfirm}
          confirmLabel={m.inbox.disconnect}
          cancelLabel={m.common.cancel}
          pending={pending}
          error={null}
          onConfirm={() =>
            void run(() => apiRequest(path, { method: 'DELETE' })).then(() => setConfirm(null))
          }
          onClose={() => setConfirm(null)}
        />
        {channel.channel === 'whatsapp' ? (
          <TemplatesSection channel={channel} templates={templates} />
        ) : null}
        {channel.provider.startsWith('fake_') ? <SimulateInbound channel={channel} /> : null}
      </Card>
    </li>
  );
}

function EditChannelDialog({
  open,
  channel,
  provider,
  onClose,
}: {
  open: boolean;
  channel: ChannelDetail;
  provider: ProviderInfo;
  onClose: () => void;
}) {
  const m = useMessages();
  const { organizationId } = useOrg();
  const { run, pending, error, reset } = useMutation();
  const [name, setName] = useState(channel.name);
  const [credentials, setCredentials] = useState<Record<string, string>>({});

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const replaced = filled(credentials);
    const ok = await run(() =>
      apiRequest(`/app/orgs/${organizationId}/communications/channels/${channel.id}`, {
        method: 'PATCH',
        body: { name, ...(Object.keys(replaced).length > 0 ? { credentials: replaced } : {}) },
      }),
    );
    if (ok) {
      setCredentials({});
      onClose();
    }
  }

  return (
    <Dialog
      open={open}
      onClose={() => {
        reset();
        setCredentials({});
        onClose();
      }}
      title={m.inbox.editTitle}
    >
      <form onSubmit={submit} className="space-y-3">
        {error ? <Alert tone="error">{error.message}</Alert> : null}
        <TextField
          label={m.inbox.channelName}
          required
          maxLength={100}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <CredentialInputs
          provider={provider}
          values={credentials}
          onChange={setCredentials}
          channel={channel}
        />
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onClose}>
            {m.common.cancel}
          </Button>
          <Button type="submit" loading={pending}>
            {m.common.save}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function TemplatesSection({
  channel,
  templates,
}: {
  channel: ChannelDetail;
  templates: TemplateSummary[];
}) {
  const m = useMessages();
  const { organizationId } = useOrg();
  const { run, pending, error } = useMutation();
  const [name, setName] = useState('');
  const [language, setLanguage] = useState('en');
  const [category, setCategory] = useState<TemplateSummary['category']>('utility');
  const [body, setBody] = useState('');

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const ok = await run(() =>
      apiRequest(`/app/orgs/${organizationId}/communications/channels/${channel.id}/templates`, {
        body: { name, language, category, body },
      }),
    );
    if (ok) {
      setName('');
      setBody('');
    }
  }

  return (
    <details className="rounded-md border border-slate-200 p-3">
      <summary className="cursor-pointer text-sm font-medium text-slate-800">
        {m.inbox.templatesTitle} ({templates.length})
      </summary>
      <p className="mt-2 text-xs text-slate-500">{m.inbox.templatesHint}</p>
      {templates.length > 0 ? (
        <ul className="mt-2 space-y-2">
          {templates.map((template) => (
            <li key={template.id} className="rounded bg-slate-50 p-2 text-sm">
              <span className="font-mono text-xs text-slate-700">
                {template.name} · {template.language} ·{' '}
                {m.inbox.templateCategories[template.category]}
              </span>
              <p className="whitespace-pre-wrap text-slate-800">{template.body}</p>
            </li>
          ))}
        </ul>
      ) : null}
      <form onSubmit={submit} className="mt-3 grid gap-3 sm:grid-cols-3">
        {error ? (
          <div className="sm:col-span-3">
            <Alert tone="error">{error.message}</Alert>
          </div>
        ) : null}
        <TextField
          label={m.inbox.templateName}
          required
          pattern="[a-z0-9_]+"
          maxLength={512}
          value={name}
          error={error?.fieldError('name')}
          onChange={(event) => setName(event.target.value)}
        />
        <TextField
          label={m.inbox.templateLanguage}
          required
          maxLength={6}
          value={language}
          error={error?.fieldError('language')}
          onChange={(event) => setLanguage(event.target.value)}
        />
        <SelectField
          label={m.inbox.templateCategory}
          value={category}
          onChange={(event) => setCategory(event.target.value as TemplateSummary['category'])}
        >
          {(['utility', 'marketing', 'authentication'] as const).map((value) => (
            <option key={value} value={value}>
              {m.inbox.templateCategories[value]}
            </option>
          ))}
        </SelectField>
        <TextAreaField
          className="sm:col-span-3"
          label={m.inbox.templateBody}
          required
          rows={3}
          maxLength={1_024}
          value={body}
          error={error?.fieldError('body')}
          onChange={(event) => setBody(event.target.value)}
        />
        <div className="sm:col-span-3">
          <Button type="submit" size="sm" variant="secondary" loading={pending}>
            {m.inbox.registerTemplate}
          </Button>
        </div>
      </form>
    </details>
  );
}

/** Development only (fake providers): a signed test message through the webhook pipeline. */
function SimulateInbound({ channel }: { channel: ChannelDetail }) {
  const m = useMessages();
  const { organizationId } = useOrg();
  const { run, pending, error } = useMutation();
  const [from, setFrom] = useState('');
  const [fromName, setFromName] = useState('');
  const [text, setText] = useState('');
  const [done, setDone] = useState(false);

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setDone(false);
    const ok = await run(() =>
      apiRequest(`/app/dev/communications/${organizationId}/channels/${channel.id}/inbound`, {
        body: { from, text, ...(fromName.trim() ? { fromName: fromName.trim() } : {}) },
      }),
    );
    if (ok) {
      setText('');
      setDone(true);
    }
  }

  return (
    <details className="rounded-md border border-dashed border-slate-300 p-3">
      <summary className="cursor-pointer text-sm font-medium text-slate-800">
        {m.inbox.simulateTitle}
      </summary>
      <p className="mt-2 text-xs text-slate-500">{m.inbox.simulateHint}</p>
      <form onSubmit={submit} className="mt-3 grid gap-3 sm:grid-cols-2">
        {error ? (
          <div className="sm:col-span-2">
            <Alert tone="error">{error.message}</Alert>
          </div>
        ) : null}
        {done ? (
          <div className="sm:col-span-2">
            <Alert tone="success">{m.inbox.simulated}</Alert>
          </div>
        ) : null}
        <TextField
          label={m.inbox.simulateFrom}
          required
          maxLength={320}
          value={from}
          onChange={(event) => setFrom(event.target.value)}
        />
        <TextField
          label={m.inbox.simulateName}
          maxLength={200}
          value={fromName}
          onChange={(event) => setFromName(event.target.value)}
        />
        <TextAreaField
          className="sm:col-span-2"
          label={m.inbox.simulateText}
          required
          rows={2}
          maxLength={10_000}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <div className="sm:col-span-2">
          <Button type="submit" size="sm" variant="secondary" loading={pending}>
            {m.inbox.simulate}
          </Button>
        </div>
      </form>
    </details>
  );
}
