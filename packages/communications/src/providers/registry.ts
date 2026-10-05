import type { Channel } from '@businessos/database';
import type { ChannelProvider } from '../types';

/** Providers available on this deployment (configured by the API/worker at startup). */
export class ChannelProviderRegistry {
  private readonly providers = new Map<string, ChannelProvider>();

  constructor(providers: readonly ChannelProvider[] = []) {
    for (const provider of providers) this.register(provider);
  }

  register(provider: ChannelProvider): this {
    if (this.providers.has(provider.key))
      throw new Error(`Duplicate channel provider: ${provider.key}`);
    this.providers.set(provider.key, provider);
    return this;
  }

  get(key: string): ChannelProvider | undefined {
    return this.providers.get(key);
  }

  list(channel?: Channel): ChannelProvider[] {
    return [...this.providers.values()].filter(
      (provider) => !channel || provider.channel === channel,
    );
  }
}

export interface ChannelProviderOptions {
  /** Development/test fake providers (refused in production by configuration). */
  fake: boolean;
  fetch?: typeof fetch;
}
