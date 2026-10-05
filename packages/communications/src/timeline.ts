import type { ActivityProjector, ProjectorMap } from '@businessos/activities';
import type { ActivityType } from '@businessos/activities';
import { conversations, messages } from '@businessos/database';
import type { EventPayload } from '@businessos/events';
import { eq } from 'drizzle-orm';

const LABEL = { email: 'Email', whatsapp: 'WhatsApp', sms: 'SMS' } as const;

function messageProjector(direction: 'received' | 'sent'): ActivityProjector {
  return async (tx, event) => {
    const payload = event.payload as EventPayload<'message.received'>;
    const [row] = await tx
      .select({ message: messages, conversation: conversations })
      .from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .where(eq(messages.id, payload.messageId));
    if (!row) return null;
    const contactId = row.conversation.contactId;
    if (!contactId) return null;
    const preview = row.message.bodyText.replace(/\s+/g, ' ').trim().slice(0, 200);
    const who = row.conversation.counterpartName ?? row.conversation.counterpartAddress;
    const label = LABEL[payload.channel];
    const subject = row.message.subject ? ` — ${row.message.subject}` : '';
    return {
      type: `${payload.channel}.${direction}` as ActivityType,
      subject: { type: 'message', id: row.message.id },
      contactId,
      summary:
        direction === 'received'
          ? `${label} from ${who}${subject}: ${preview}`
          : `${label} sent${subject}: ${preview}`,
      metadata: { conversationId: row.conversation.id, preview },
    };
  };
}

/** Messages appear on the contact timeline (visible with `communications.read`). */
export const communicationsTimelineProjectors: ProjectorMap = {
  'message.received': messageProjector('received'),
  'message.sent': messageProjector('sent'),
};
