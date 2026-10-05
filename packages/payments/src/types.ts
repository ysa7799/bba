import type { Money } from '@businessos/shared';

/** Provider-independent payment status. */
export type NormalizedPaymentStatus =
  | 'pending'
  | 'requires_action'
  | 'authorized'
  | 'captured'
  | 'failed'
  | 'canceled'
  | 'partially_refunded'
  | 'refunded';

export type PaymentMethodType = 'card' | 'apple_pay' | 'benefit' | 'mada' | 'knet' | 'other';

export interface PaymentMethodCapabilities {
  method: PaymentMethodType;
  /** Can be charged again without the customer present (merchant-initiated). */
  recurring: boolean;
  refunds: boolean;
  partialRefunds: boolean;
  currencies: readonly string[];
  countries: readonly string[];
}

export interface ProviderCapabilities {
  hostedCheckout: boolean;
  webhooks: boolean;
  methods: readonly PaymentMethodCapabilities[];
}

/** Authoritative view of a payment as reported by the provider's API. */
export interface ProviderPayment {
  providerPaymentId: string;
  status: NormalizedPaymentStatus;
  amount: Money;
  /** Total refunded so far (same currency). */
  refunded: Money;
  method: PaymentMethodType | null;
  failureCode: string | null;
  failureMessage: string | null;
  /** Our reference echoed back by the provider (the internal payment id). */
  reference: string | null;
}

export interface CreateCheckoutInput {
  /** Internal payment id; providers echo it back as the merchant reference. */
  reference: string;
  amount: Money;
  description: string;
  customer: { name: string; email: string };
  /** Where the customer returns after paying (a hint only; never proof of payment). */
  returnUrl: string;
  /** Where the provider posts webhooks. */
  webhookUrl: string;
  /** Restrict to a method family (e.g. BENEFIT), or all supported methods. */
  method?: PaymentMethodType | 'all';
  metadata?: Record<string, string>;
  /** Idempotency key so a retried create does not create two charges. */
  idempotencyKey: string;
}

export interface ProviderCheckout {
  providerPaymentId: string;
  redirectUrl: string;
  status: NormalizedPaymentStatus;
}

/** A verified webhook notification. Its status is a hint: callers re-fetch the payment. */
export interface NormalizedPaymentEvent {
  providerEventId: string;
  providerPaymentId: string;
  reportedStatus: NormalizedPaymentStatus;
  reference: string | null;
  raw: Record<string, unknown>;
}

export interface RefundInput {
  providerPaymentId: string;
  amount: Money;
  reason: string;
  reference: string;
  idempotencyKey: string;
}

export interface ProviderRefund {
  providerRefundId: string;
  status: 'pending' | 'succeeded' | 'failed';
}

export type ProviderStatus = 'ready' | 'configuration_required';

/**
 * Port every payment provider adapter implements. Provider-specific code (URLs, field names,
 * signature schemes, status vocabularies) lives only inside adapters.
 */
export interface PaymentProvider {
  readonly name: string;
  readonly capabilities: ProviderCapabilities;
  status(): ProviderStatus;
  createCheckout(input: CreateCheckoutInput): Promise<ProviderCheckout>;
  /** Server-side verification: the only source of truth for payment state. */
  retrievePayment(providerPaymentId: string): Promise<ProviderPayment>;
  /** Verifies authenticity; returns null for well-formed but irrelevant notifications. Throws on bad signatures. */
  parseWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): NormalizedPaymentEvent | null;
  refund(input: RefundInput): Promise<ProviderRefund>;
}
