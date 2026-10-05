import {
  FakePaymentProvider,
  PaymentProviderRegistry,
  TapPaymentProvider,
  type PaymentServices,
} from '@businessos/payments';
import type { FastifyBaseLogger } from 'fastify';
import type { ApiEnv } from '../env';

/** Builds the provider registry from configuration. */
export function createPaymentProviders(env: ApiEnv): PaymentProviderRegistry {
  const registry = new PaymentProviderRegistry();
  if (env.PAYMENTS_PROVIDER === 'fake') {
    registry.register(
      new FakePaymentProvider({
        webhookSecret: env.FAKE_PAYMENTS_WEBHOOK_SECRET,
        checkoutBaseUrl: `${new URL(env.APP_URL).origin}/dev/fake-checkout`,
      }),
    );
  }
  if (env.PAYMENTS_PROVIDER === 'tap') {
    registry.register(
      new TapPaymentProvider({
        secretKey: env.TAP_SECRET_KEY ?? null,
        ...(env.TAP_API_BASE_URL ? { baseUrl: env.TAP_API_BASE_URL } : {}),
      }),
    );
  }
  return registry;
}

export function paymentServices(
  env: ApiEnv,
  registry: PaymentProviderRegistry,
  db: PaymentServices['db'],
  logger: FastifyBaseLogger,
): PaymentServices {
  return {
    db,
    providers: registry,
    checkoutProvider: env.PAYMENTS_PROVIDER,
    appUrl: new URL(env.APP_URL).origin,
    apiPublicUrl: env.API_PUBLIC_URL.replace(/\/+$/, ''),
    logger,
  };
}
