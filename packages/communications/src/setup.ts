import { CHANNELS } from '@businessos/database';
import { FakeChannelProvider } from './providers/fake';
import { PostmarkEmailProvider } from './providers/postmark';
import { ChannelProviderRegistry, type ChannelProviderOptions } from './providers/registry';
import { TwilioSmsProvider } from './providers/twilio';
import { WhatsAppCloudProvider } from './providers/whatsapp-cloud';

/** Providers offered on a deployment: real adapters always (they need per-tenant credentials). */
export function createChannelProviders(options: ChannelProviderOptions): ChannelProviderRegistry {
  const http = options.fetch ? { fetch: options.fetch } : {};
  const registry = new ChannelProviderRegistry([
    new PostmarkEmailProvider(http),
    new WhatsAppCloudProvider(http),
    new TwilioSmsProvider(http),
  ]);
  if (options.fake) {
    for (const channel of CHANNELS) registry.register(new FakeChannelProvider(channel));
  }
  return registry;
}
