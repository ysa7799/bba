import { money, ProviderError } from '@businessos/shared';
import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  canTransition,
  mapTapStatus,
  TapPaymentProvider,
  tapAmountToMoney,
  tapWebhookHash,
  WebhookSignatureError,
} from '../src';

const SECRET = 'sk_test_1234567890abcdef';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const charge = {
  id: 'chg_TS0123456789',
  status: 'CAPTURED',
  amount: 15,
  currency: 'BHD',
  reference: { transaction: '01a10a7d-64ba-7000-a694-68839952f9b9', payment: 'P1234' },
  gateway: { reference: 'G5678' },
  transaction: { url: 'https://checkout.tap.company/pay/abc', created: '1791180000000' },
  source: { payment_method: 'BENEFIT' },
};

describe('Tap status mapping and state machine', () => {
  it('maps Tap statuses to normalized statuses', () => {
    expect(mapTapStatus('CAPTURED')).toBe('captured');
    expect(mapTapStatus('INITIATED')).toBe('requires_action');
    expect(mapTapStatus('DECLINED')).toBe('failed');
    expect(mapTapStatus('ABANDONED')).toBe('canceled');
    expect(mapTapStatus('SOMETHING_NEW')).toBe('pending');
  });

  it('only moves payment state forward', () => {
    expect(canTransition('pending', 'captured')).toBe(true);
    expect(canTransition('captured', 'pending')).toBe(false);
    expect(canTransition('failed', 'captured')).toBe(false);
    expect(canTransition('captured', 'refunded')).toBe(true);
    expect(canTransition('refunded', 'captured')).toBe(false);
  });

  it('converts provider decimal amounts without float drift (BHD has 3 decimals)', () => {
    expect(tapAmountToMoney(15, 'BHD')).toEqual(money(15_000n, 'BHD'));
    expect(tapAmountToMoney(0.1 + 0.2, 'BHD')).toEqual(money(300n, 'BHD'));
    expect(tapAmountToMoney(12.345, 'BHD')).toEqual(money(12_345n, 'BHD'));
    expect(() => tapAmountToMoney(1, 'XYZ')).toThrow(ProviderError);
  });
});

describe('TapPaymentProvider', () => {
  it('reports CONFIGURATION_REQUIRED and never calls Tap without a secret key', async () => {
    const fetchMock = vi.fn();
    const provider = new TapPaymentProvider({ secretKey: null, fetch: fetchMock });
    expect(provider.status()).toBe('configuration_required');
    await expect(provider.retrievePayment('chg_x')).rejects.toThrow(/CONFIGURATION_REQUIRED/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('creates a hosted checkout with a decimal BHD amount, BENEFIT source and callback URLs', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ...charge, status: 'INITIATED' }));
    const provider = new TapPaymentProvider({ secretKey: SECRET, fetch: fetchMock });
    const result = await provider.createCheckout({
      reference: charge.reference.transaction,
      amount: money(15_000n, 'BHD'),
      description: 'Subscription',
      customer: { name: 'Org A', email: 'billing@orga.example' },
      returnUrl: 'https://app.example.com/o/1/billing/return?checkout=2',
      webhookUrl: 'https://api.example.com/webhooks/payments/tap',
      method: 'benefit',
      idempotencyKey: 'payment-1',
    });
    expect(result).toEqual({
      providerPaymentId: charge.id,
      redirectUrl: charge.transaction.url,
      status: 'requires_action',
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.tap.company/v2/charges');
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${SECRET}`);
    expect((init.headers as Record<string, string>)['idempotency-key']).toBe('payment-1');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      amount: 15,
      currency: 'BHD',
      source: { id: 'src_bh.benefit' },
      redirect: { url: 'https://app.example.com/o/1/billing/return?checkout=2' },
      post: { url: 'https://api.example.com/webhooks/payments/tap' },
      reference: { transaction: charge.reference.transaction },
    });
  });

  it('retrieves and normalizes a charge', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(charge));
    const provider = new TapPaymentProvider({ secretKey: SECRET, fetch: fetchMock });
    const payment = await provider.retrievePayment(charge.id);
    expect(payment).toMatchObject({
      providerPaymentId: charge.id,
      status: 'captured',
      amount: money(15_000n, 'BHD'),
      method: 'benefit',
      reference: charge.reference.transaction,
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`https://api.tap.company/v2/charges/${charge.id}`);
  });

  it('rejects suspicious charge ids before calling Tap', async () => {
    const fetchMock = vi.fn();
    const provider = new TapPaymentProvider({ secretKey: SECRET, fetch: fetchMock });
    await expect(provider.retrievePayment('../refunds')).rejects.toBeInstanceOf(ProviderError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('turns HTTP and payload errors into provider errors without leaking bodies', async () => {
    const provider5xx = new TapPaymentProvider({
      secretKey: SECRET,
      fetch: vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ errors: [{ description: 'internal secret detail' }] }, 503),
        ),
    });
    const error = await provider5xx.retrievePayment('chg_1').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).retryable).toBe(true);
    expect((error as Error).message).not.toContain('secret detail');

    const malformed = new TapPaymentProvider({
      secretKey: SECRET,
      fetch: vi.fn().mockResolvedValue(jsonResponse({ unexpected: true })),
    });
    await expect(malformed.retrievePayment('chg_1')).rejects.toBeInstanceOf(ProviderError);
  });

  describe('webhook verification', () => {
    const provider = new TapPaymentProvider({ secretKey: SECRET, fetch: vi.fn() });
    const raw = Buffer.from(JSON.stringify(charge));

    it('computes the hashstring over the documented fields', () => {
      const expected = createHmac('sha256', SECRET)
        .update(
          `x_id${charge.id}x_amount15.000x_currencyBHDx_gateway_referenceG5678x_payment_referenceP1234x_statusCAPTUREDx_created1791180000000`,
        )
        .digest('hex');
      expect(tapWebhookHash(charge, SECRET)).toBe(expected);
    });

    it('accepts a correctly signed charge notification as a hint', () => {
      const event = provider.parseWebhook(raw, { hashstring: tapWebhookHash(charge, SECRET) });
      expect(event).toMatchObject({
        providerEventId: `${charge.id}:CAPTURED`,
        providerPaymentId: charge.id,
        reportedStatus: 'captured',
      });
    });

    it('rejects missing, wrong and tampered signatures', () => {
      expect(() => provider.parseWebhook(raw, {})).toThrow(WebhookSignatureError);
      expect(() => provider.parseWebhook(raw, { hashstring: 'deadbeef' })).toThrow(
        WebhookSignatureError,
      );
      const tampered = Buffer.from(JSON.stringify({ ...charge, amount: 0.001 }));
      expect(() =>
        provider.parseWebhook(tampered, { hashstring: tapWebhookHash(charge, SECRET) }),
      ).toThrow(WebhookSignatureError);
      expect(() => provider.parseWebhook(Buffer.from('not json'), { hashstring: 'x' })).toThrow(
        WebhookSignatureError,
      );
    });
  });
});
