import { OAuthProviderRegistry } from '@businessos/integrations';
import { createCalendarProviders } from '@businessos/calendar';
import {
  ChannelProviderRegistry,
  createConnection,
  FakeChannelProvider,
  queueMessage,
  startConversation,
  type CommunicationsServices,
} from '@businessos/communications';
import { createContact, type CrmContext } from '@businessos/crm';
import { messages, withTenant, type DatabaseHandle, type TenantTx } from '@businessos/database';
import { SubscriberRegistry } from '@businessos/events';
import { JOBS, type JobContext } from '@businessos/jobs';
import { SecretBox } from '@businessos/shared';
import {
  createTestDatabase,
  createTestWorld,
  uniqueSuffix,
  type TestWorld,
} from '@businessos/testing';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { MemoryFileStorage } from '@businessos/files';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FileEmailTransport } from '../src/email/transports';
import { buildHandlers } from '../src/handlers';

let handle: DatabaseHandle;
let world: TestWorld;
const fakeEmail = new FakeChannelProvider('email');
const communications: CommunicationsServices = {
  providers: new ChannelProviderRegistry([fakeEmail]),
  secretBox: new SecretBox([{ id: 'test', key: randomBytes(32) }]),
  publicApiUrl: 'https://api.test',
};

beforeAll(async () => {
  handle = createTestDatabase(4);
  world = await createTestWorld(handle.db);
});

afterAll(async () => {
  await handle.close();
});

function inOrgA<T>(fn: (tx: TenantTx, ctx: CrmContext) => Promise<T>): Promise<T> {
  const org = world.orgA.organization;
  const userId = world.orgA.users.owner.id;
  return withTenant(handle.db, { organizationId: org.id, userId }, (tx) =>
    fn(tx, {
      organizationId: org.id,
      countryCode: org.countryCode,
      defaultCurrency: org.defaultCurrency,
      timezone: org.timezone,
      actor: { type: 'user', userId },
    }),
  );
}

const context = (attempt: number): JobContext => ({ jobId: `msg-${attempt}`, attempt, meta: {} });

describe('communications.send handler', () => {
  it('retries retryable failures and marks the message failed only on the last attempt', async () => {
    const handlers = buildHandlers({
      db: handle.db,
      communications,
      calendar: { providers: createCalendarProviders({ fake: true }), secretBox: null },
      automation: { allowPrivateNetwork: false, enqueue: () => Promise.resolve() },
      files: { db: handle.db, storage: new MemoryFileStorage() },
      integrations: {
        db: handle.db,
        secretBox: null,
        providers: new OAuthProviderRegistry(),
        redirectUri: 'http://localhost:3000/oauth/callback',
      },
      webhooks: {
        db: handle.db,
        secretBox: null,
        allowPrivateNetwork: false,
        ownHosts: [],
        enqueueAttempt: () => Promise.resolve(),
      },
      appUrl: 'http://localhost:3000',
      registry: new SubscriberRegistry(),
      email: new FileEmailTransport('/dev/null'),
      logger: pino({ level: 'silent' }),
    });
    const send = handlers['communications.send'];
    if (!send) throw new Error('handler missing');
    const conversationId = await inOrgA(async (tx, ctx) => {
      const { connection } = await createConnection(tx, ctx, communications, {
        provider: 'fake_email',
        name: 'Support',
        address: `support.${uniqueSuffix()}@manama.example`,
      });
      const contact = await createContact(tx, ctx, {
        firstName: 'Mariam',
        email: `mariam.${uniqueSuffix()}@example.com`,
      });
      const started = await startConversation(tx, ctx, {
        connectionId: connection.id,
        contactId: contact.id,
        subject: 'Order',
      });
      return started.conversation.id;
    });
    const queue = (text: string) =>
      inOrgA((tx, ctx) => queueMessage(tx, ctx, conversationId, { text, subject: 'Order' }));
    const statusOf = async (id: string) =>
      (await inOrgA((tx) => tx.select().from(messages).where(eq(messages.id, id))))[0]?.status;
    const organizationId = world.orgA.organization.id;

    const delivered = await queue('Your order is ready');
    await expect(send({ organizationId, messageId: delivered.id }, context(1))).resolves.toEqual({
      outcome: 'sent',
    });
    expect(fakeEmail.sent.at(-1)).toMatchObject({ text: 'Your order is ready' });
    expect(await statusOf(delivered.id)).toBe('sent');

    const flaky = await queue('Second message');
    fakeEmail.failNext('timeout', true);
    // Not the last attempt: the job rethrows so BullMQ retries; the message stays queued.
    await expect(send({ organizationId, messageId: flaky.id }, context(1))).rejects.toThrow();
    expect(await statusOf(flaky.id)).toBe('queued');
    fakeEmail.failNext('timeout', true);
    await expect(
      send({ organizationId, messageId: flaky.id }, context(JOBS['communications.send'].attempts)),
    ).resolves.toEqual({ outcome: 'failed' });
    expect(await statusOf(flaky.id)).toBe('failed');
    // A redelivered job for a finished message does nothing.
    await expect(send({ organizationId, messageId: delivered.id }, context(2))).resolves.toEqual({
      outcome: 'skipped',
    });
  });
});
