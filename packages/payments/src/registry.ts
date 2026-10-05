import { NotFoundError } from '@businessos/shared';
import type { PaymentProvider } from './types';

export class PaymentProviderRegistry {
  private readonly providers = new Map<string, PaymentProvider>();

  register(provider: PaymentProvider): this {
    if (this.providers.has(provider.name)) throw new Error(`Duplicate provider ${provider.name}`);
    this.providers.set(provider.name, provider);
    return this;
  }

  get(name: string): PaymentProvider {
    const provider = this.providers.get(name);
    if (!provider) throw new NotFoundError('Payment provider');
    return provider;
  }

  has(name: string): boolean {
    return this.providers.has(name);
  }

  names(): string[] {
    return [...this.providers.keys()];
  }
}
