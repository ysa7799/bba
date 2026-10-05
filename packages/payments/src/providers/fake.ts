import { NotFoundError, money, type Money } from '@businessos/shared';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type {
  CreateCheckoutInput,
  NormalizedPaymentEvent,
  NormalizedPaymentStatus,
  PaymentProvider,
  ProviderCheckout,
  ProviderPayment,
  ProviderRefund,
  RefundInput,
} from '../types';

interface FakePayment {
  amount: Money;
  refunded: Money;
  status: NormalizedPaymentStatus;
  reference: string;
}

const webhookSchema = z.object({
  id: z.string().min(1).max(200),
  payment_id: z.string().min(1).max(200),
  status: z.enum([
    'pending',
    'requires_action',
    'authorized',
    'captured',
    'failed',
    'canceled',
    'partially_refunded',
    'refunded',
  ]),
  reference: z.string().nullable(),
});

export const FAKE_SIGNATURE_HEADER = 'x-fake-signature';

/**
 * In-process fake provider for development and tests. It behaves like a real provider: hosted
 * checkout URL, server-side retrieval, HMAC-signed webhooks. Refused in production by config.
 */
export class FakePaymentProvider implements PaymentProvider {
  readonly name = 'fake';
  readonly capabilities = {
    hostedCheckout: true,
    webhooks: true,
    methods: [
      {
        method: 'card' as const,
        recurring: false,
        refunds: true,
        partialRefunds: true,
        currencies: ['BHD', 'SAR', 'AED', 'KWD', 'USD'],
        countries: ['BH', 'SA', 'AE', 'KW'],
      },
    ],
  };
  private readonly payments = new Map<string, FakePayment>();
  private readonly idempotency = new Map<string, string>();

  constructor(private readonly options: { webhookSecret: string; checkoutBaseUrl: string }) {}

  status() {
    return 'ready' as const;
  }

  createCheckout(input: CreateCheckoutInput): Promise<ProviderCheckout> {
    const existing = this.idempotency.get(input.idempotencyKey);
    const id = existing ?? `fake_${randomBytes(8).toString('hex')}`;
    if (!existing) {
      this.idempotency.set(input.idempotencyKey, id);
      this.payments.set(id, {
        amount: input.amount,
        refunded: money(0n, input.amount.currency),
        status: 'pending',
        reference: input.reference,
      });
    }
    const url = new URL(this.options.checkoutBaseUrl);
    url.searchParams.set('payment', id);
    url.searchParams.set('return', input.returnUrl);
    return Promise.resolve({
      providerPaymentId: id,
      redirectUrl: url.toString(),
      status: 'pending',
    });
  }

  retrievePayment(providerPaymentId: string): Promise<ProviderPayment> {
    const payment = this.payments.get(providerPaymentId);
    if (!payment) return Promise.reject(new NotFoundError('Payment'));
    return Promise.resolve({
      providerPaymentId,
      status: payment.status,
      amount: payment.amount,
      refunded: payment.refunded,
      method: 'card',
      failureCode: payment.status === 'failed' ? 'card_declined' : null,
      failureMessage: payment.status === 'failed' ? 'The card was declined' : null,
      reference: payment.reference,
    });
  }

  parseWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): NormalizedPaymentEvent | null {
    const signature = headers[FAKE_SIGNATURE_HEADER];
    if (typeof signature !== 'string' || !this.verify(rawBody, signature)) {
      throw new WebhookSignatureError();
    }
    const body = webhookSchema.parse(JSON.parse(rawBody.toString('utf8')));
    return {
      providerEventId: body.id,
      providerPaymentId: body.payment_id,
      reportedStatus: body.status,
      reference: body.reference,
      raw: body,
    };
  }

  refund(input: RefundInput): Promise<ProviderRefund> {
    const payment = this.payments.get(input.providerPaymentId);
    if (!payment) return Promise.reject(new NotFoundError('Payment'));
    const refunded = payment.refunded.amountMinor + input.amount.amountMinor;
    payment.refunded = money(refunded, payment.amount.currency);
    payment.status = refunded >= payment.amount.amountMinor ? 'refunded' : 'partially_refunded';
    return Promise.resolve({
      providerRefundId: `fake_re_${randomBytes(6).toString('hex')}`,
      status: 'succeeded',
    });
  }

  // ---- Simulation controls (development and tests) ----

  /** Simulates the customer completing (or failing) payment on the hosted page. */
  simulate(providerPaymentId: string, status: NormalizedPaymentStatus): void {
    const payment = this.payments.get(providerPaymentId);
    if (!payment) throw new NotFoundError('Payment');
    payment.status = status;
  }

  /** Simulates a provider reporting a different amount than requested (tampering test). */
  tamperAmount(providerPaymentId: string, amount: Money): void {
    const payment = this.payments.get(providerPaymentId);
    if (!payment) throw new NotFoundError('Payment');
    payment.amount = amount;
  }

  /** Produces a correctly signed webhook body, as the provider would send it. */
  signedWebhook(event: z.input<typeof webhookSchema>): {
    body: string;
    headers: Record<string, string>;
  } {
    const body = JSON.stringify(event);
    return {
      body,
      headers: {
        [FAKE_SIGNATURE_HEADER]: this.sign(Buffer.from(body)),
        'content-type': 'application/json',
      },
    };
  }

  private sign(rawBody: Buffer): string {
    return createHmac('sha256', this.options.webhookSecret).update(rawBody).digest('hex');
  }

  private verify(rawBody: Buffer, signature: string): boolean {
    const expected = Buffer.from(this.sign(rawBody), 'hex');
    const actual = Buffer.from(signature, 'hex');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }
}

export class WebhookSignatureError extends Error {
  constructor() {
    super('Invalid webhook signature');
    this.name = 'WebhookSignatureError';
  }
}
