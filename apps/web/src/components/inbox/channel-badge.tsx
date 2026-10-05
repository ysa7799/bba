import { getMessages } from '@/i18n';
import { cn } from '@/lib/cn';
import type { Channel } from '@/lib/inbox-types';

// Static class names so Tailwind keeps them in the build.
const STYLES: Record<Channel, string> = {
  whatsapp: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  email: 'bg-sky-50 text-sky-700 ring-sky-200',
  sms: 'bg-purple-50 text-purple-700 ring-purple-200',
};

export function ChannelBadge({ channel }: { channel: Channel }) {
  const m = getMessages('en');
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-xs font-medium ring-1 ring-inset',
        STYLES[channel],
      )}
    >
      {m.inbox.channels[channel]}
    </span>
  );
}
