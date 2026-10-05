import {
  currencyExponent,
  formatDecimal,
  isCurrencyCode,
  money,
  parseMoney,
  ProviderError,
  type Money,
} from '@businessos/shared';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type {
  CreateCheckoutInput,
  NormalizedPaymentEvent,
  NormalizedPaymentStatus,
  PaymentMethodType,
  PaymentProvider,
  ProviderCheckout,
  ProviderPayment,
  ProviderRefund,
  ProviderStatus,
  RefundInput,
} from '../types';
import { WebhookSignatureError } from './fake';

/*
 * Tap Payments adapter (https://developers.tap.company). Everything Tap-specific — endpoints,
 * field names, status vocabulary and the `hashstring` webhook signature — stays in this file.
 *
 * Live use is CONFIGURATION_REQUIRED: without `TAP_SECRET_KEY` the adapter reports
 * `configuration_required` and refuses to call Tap. Webhooks are only hints; the payment
 * service always re-fetches the charge with `retrievePayment` before changing state.
 */

export interface TapConfig {
  secretKey: string | null;
  baseUrl?: string;
  /** Injected for tests; defaults to global fetch. */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const GCC_CURRENCIES = [
  'BHD',
  'KWD',
  'SAR',
  'AED',
  'QAR',
  'OMR',
  'EGP',
  'JOD',
  'USD',
  'EUR',
  'GBP',
];
const GCC_COUNTRIES = ['BH', 'KW', 'SA', 'AE', 'QA', 'OM', 'EG', 'JO'];

const chargeSchema = z.object({
  id: z.string(),
  status: z.string(),
  amount: z.number(),
  currency: z.string(),
  reference: z
    .object({
      transaction: z.string().optional(),
      order: z.string().optional(),
      payment: z.string().optional(),
      gateway: z.string().optional(),
    })
    .partial()
    .optional(),
  gateway: z.object({ reference: z.string().optional() }).partial().optional(),
  transaction: z
    .object({ url: z.string().optional(), created: z.union([z.string(), z.number()]).optional() })
    .partial()
    .optional(),
  response: z
    .object({ code: z.string().optional(), message: z.string().optional() })
    .partial()
    .optional(),
  source: z
    .object({ payment_method: z.string().optional(), id: z.string().optional() })
    .partial()
    .optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

type TapCharge = z.infer<typeof chargeSchema>;

const refundSchema = z.object({ id: z.string(), status: z.string() });

/** Tap charge status → normalized status. Unknown statuses stay non-terminal (pending). */
export function mapTapStatus(status: string): NormalizedPaymentStatus {
  switch (status.toUpperCase()) {
    case 'CAPTURED':
      return 'captured';
    case 'AUTHORIZED':
      return 'authorized';
    case 'INITIATED':
      return 'requires_action';
    case 'IN_PROGRESS':
      return 'pending';
    case 'FAILED':
    case 'DECLINED':
    case 'RESTRICTED':
    case 'TIMEDOUT':
      return 'failed';
    case 'ABANDONED':
    case 'CANCELLED':
    case 'VOID':
      return 'canceled';
    case 'REFUNDED':
      return 'refunded';
    default:
      return 'pending';
  }
}

function mapMethod(paymentMethod: string | undefined): PaymentMethodType | null {
  if (!paymentMethod) return null;
  const value = paymentMethod.toUpperCase();
  if (value.includes('BENEFIT')) return 'benefit';
  if (value.includes('APPLE')) return 'apple_pay';
  if (value.includes('MADA')) return 'mada';
  if (value.includes('KNET')) return 'knet';
  if (
    value === 'VISA' ||
    value === 'MASTERCARD' ||
    value === 'AMERICAN_EXPRESS' ||
    value.includes('CARD')
  ) {
    return 'card';
  }
  return 'other';
}

/** Converts Tap's decimal amount (a JSON number) to Money without float drift. */
export function tapAmountToMoney(amount: number, currency: string): Money {
  if (!isCurrencyCode(currency)) {
    throw new ProviderError('tap', `Unsupported currency from provider: ${currency}`);
  }
  return parseMoney(amount.toFixed(currencyExponent(currency)), currency);
}

/**
 * Tap webhook signature: HMAC-SHA256 (secret key) over
 * `x_id{id}x_amount{amount}x_currency{currency}x_gateway_reference{gateway.reference}`
 * `x_payment_reference{reference.payment}x_status{status}x_created{transaction.created}`,
 * hex-encoded in the `hashstring` header. Amount uses the currency's decimal places.
 */
export function tapWebhookHash(charge: TapCharge, secretKey: string): string {
  const exponent = isCurrencyCode(charge.currency) ? currencyExponent(charge.currency) : 2;
  const toBeHashed =
    `x_id${charge.id}` +
    `x_amount${charge.amount.toFixed(exponent)}` +
    `x_currency${charge.currency}` +
    `x_gateway_reference${charge.gateway?.reference ?? ''}` +
    `x_payment_reference${charge.reference?.payment ?? ''}` +
    `x_status${charge.status}` +
    `x_created${String(charge.transaction?.created ?? '')}`;
  return createHmac('sha256', secretKey).update(toBeHashed).digest('hex');
}

export class TapPaymentProvider implements PaymentProvider {
  readonly name = 'tap';
  readonly capabilities = {
    hostedCheckout: true,
    webhooks: true,
    methods: [
      {
        method: 'card' as const,
        recurring: true,
        refunds: true,
        partialRefunds: true,
        currencies: GCC_CURRENCIES,
        countries: GCC_COUNTRIES,
      },
      {
        method: 'apple_pay' as const,
        recurring: false,
        refunds: true,
        partialRefunds: true,
        currencies: GCC_CURRENCIES,
        countries: GCC_COUNTRIES,
      },
      {
        method: 'benefit' as const,
        recurring: false,
        refunds: true,
        partialRefunds: false,
        currencies: ['BHD'],
        countries: ['BH'],
      },
    ],
  };
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly config: TapConfig) {
    this.baseUrl = (config.baseUrl ?? 'https://api.tap.company/v2').replace(/\/+$/, '');
    this.fetchImpl = config.fetch ?? fetch;
    this.timeoutMs = config.timeoutMs ?? 15_000;
  }

  status(): ProviderStatus {
    return this.config.secretKey ? 'ready' : 'configuration_required';
  }

  private secret(): string {
    if (!this.config.secretKey) {
      throw new ProviderError('tap', 'Tap Payments is not configured (CONFIGURATION_REQUIRED)');
    }
    return this.config.secretKey;
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    schema: z.ZodType<T>,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<T> {
    // Resolve configuration first so a missing key is reported as such, not as a network error.
    const secretKey = this.secret();
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${secretKey}`,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new ProviderError('tap', 'Could not reach Tap Payments', {
        retryable: true,
        cause: error,
      });
    }
    if (!response.ok) {
      // Never surface provider error bodies to clients; they are logged by the caller.
      throw new ProviderError('tap', `Tap Payments returned HTTP ${response.status}`, {
        retryable: response.status >= 500 || response.status === 429,
      });
    }
    const parsed = schema.safeParse(await response.json());
    if (!parsed.success) {
      throw new ProviderError('tap', 'Unexpected response from Tap Payments');
    }
    return parsed.data;
  }

  async createCheckout(input: CreateCheckoutInput): Promise<ProviderCheckout> {
    const sourceId =
      input.method === 'benefit'
        ? 'src_bh.benefit'
        : input.method === 'card'
          ? 'src_card'
          : 'src_all';
    const charge = await this.request(
      'POST',
      '/charges',
      chargeSchema,
      {
        amount: Number(formatDecimal(input.amount)),
        currency: input.amount.currency,
        threeDSecure: true,
        save_card: false,
        description: input.description.slice(0, 255),
        reference: { transaction: input.reference, order: input.reference },
        receipt: { email: false, sms: false },
        customer: { first_name: input.customer.name.slice(0, 100), email: input.customer.email },
        source: { id: sourceId },
        post: { url: input.webhookUrl },
        redirect: { url: input.returnUrl },
        metadata: { ...input.metadata, reference: input.reference },
      },
      input.idempotencyKey,
    );
    const redirectUrl = charge.transaction?.url;
    if (!redirectUrl) throw new ProviderError('tap', 'Tap Payments did not return a checkout URL');
    return { providerPaymentId: charge.id, redirectUrl, status: mapTapStatus(charge.status) };
  }

  async retrievePayment(providerPaymentId: string): Promise<ProviderPayment> {
    if (!/^[A-Za-z0-9_]{1,100}$/.test(providerPaymentId)) {
      throw new ProviderError('tap', 'Invalid charge id');
    }
    const charge = await this.request('GET', `/charges/${providerPaymentId}`, chargeSchema);
    const amount = tapAmountToMoney(charge.amount, charge.currency);
    const status = mapTapStatus(charge.status);
    return {
      providerPaymentId: charge.id,
      status,
      amount,
      refunded: money(status === 'refunded' ? amount.amountMinor : 0n, amount.currency),
      method: mapMethod(charge.source?.payment_method),
      failureCode: status === 'failed' ? (charge.response?.code ?? null) : null,
      failureMessage: status === 'failed' ? (charge.response?.message ?? null) : null,
      reference: charge.reference?.transaction ?? null,
    };
  }

  parseWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): NormalizedPaymentEvent | null {
    const signature = headers.hashstring;
    let json: unknown;
    try {
      json = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new WebhookSignatureError();
    }
    const parsed = chargeSchema.safeParse(json);
    // Refund and other object notifications are acknowledged but not processed here.
    if (!parsed.success || !parsed.data.id.startsWith('chg_')) {
      if (typeof signature !== 'string') throw new WebhookSignatureError();
      return null;
    }
    const expected = Buffer.from(tapWebhookHash(parsed.data, this.secret()), 'hex');
    const actual = typeof signature === 'string' ? Buffer.from(signature, 'hex') : Buffer.alloc(0);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new WebhookSignatureError();
    }
    return {
      providerEventId: `${parsed.data.id}:${parsed.data.status}`,
      providerPaymentId: parsed.data.id,
      reportedStatus: mapTapStatus(parsed.data.status),
      reference: parsed.data.reference?.transaction ?? null,
      raw: {
        id: parsed.data.id,
        status: parsed.data.status,
        amount: parsed.data.amount,
        currency: parsed.data.currency,
      },
    };
  }

  async refund(input: RefundInput): Promise<ProviderRefund> {
    const refund = await this.request(
      'POST',
      '/refunds',
      refundSchema,
      {
        charge_id: input.providerPaymentId,
        amount: Number(formatDecimal(input.amount)),
        currency: input.amount.currency,
        reason: input.reason.slice(0, 255),
        reference: { merchant: input.reference },
      },
      input.idempotencyKey,
    );
    const status = refund.status.toUpperCase();
    return {
      providerRefundId: refund.id,
      status:
        status === 'REFUNDED' || status === 'SUCCEEDED'
          ? 'succeeded'
          : status === 'FAILED'
            ? 'failed'
            : 'pending',
    };
  }
}
