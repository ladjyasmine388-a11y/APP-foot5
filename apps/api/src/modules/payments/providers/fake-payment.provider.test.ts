import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../../infra/config/env.js';
import { FakePaymentProvider } from './fake-payment.provider.js';
import { InvalidWebhookSignatureError, PaymentProviderError } from './payment-provider.js';

const env = loadEnv({
  NODE_ENV: 'test',
  WEB_ORIGIN: 'http://localhost:5173',
  DATABASE_URL: 'postgresql://u:p@localhost:5432/x_test',
  JWT_ACCESS_SECRET: 'unit-test-secret-with-more-than-32-characters',
  PAYMENT_WEBHOOK_SECRET: 'unit-test-webhook-secret-123456',
});

const intent = {
  paymentId: 'pay-1',
  bookingReference: 'FF-ABCD2345',
  amountMinor: 800,
  currency: 'DZD' as const,
  description: 'Acompte',
  customer: { email: 'a@b.co', phone: '+213550000000' },
  returnUrl: 'http://localhost:5173/return',
  cancelUrl: 'http://localhost:5173/cancel',
};

describe('FakePaymentProvider', () => {
  const make = () => new FakePaymentProvider(env);

  describe('paiement', () => {
    it('crée un paiement en attente avec une page de paiement hébergée', async () => {
      const p = make();
      const created = await p.createIntent(intent);
      expect(created.providerRef).toMatch(/^fake_pay_[0-9a-f]{24}$/);
      expect(created.checkoutUrl).toBe(
        `http://localhost:3000/api/v1/dev/fake-provider/checkout/${created.providerRef}`,
      );
      expect(await p.getPaymentState(created.providerRef)).toMatchObject({
        status: 'PENDING',
        amountMinor: 800,
        currency: 'DZD',
        paidAt: null,
      });
    });

    it('est idempotent : la même demande rend le même paiement', async () => {
      const p = make();
      const a = await p.createIntent(intent);
      const b = await p.createIntent(intent);
      expect(b.providerRef).toBe(a.providerRef);
    });

    it('le règlement passe le paiement à SUCCEEDED et fournit un webhook signé', async () => {
      const p = make();
      const { providerRef } = await p.createIntent(intent);
      const webhook = p.completePayment(providerRef, 'SUCCEEDED');
      expect(p.parseWebhook(webhook.rawBody, webhook.headers)).toMatchObject({
        type: 'payment.succeeded',
        providerRef,
      });
      expect(await p.getPaymentState(providerRef)).toMatchObject({
        status: 'SUCCEEDED',
        paidAt: expect.any(Date),
      });
    });

    it('un paiement déjà réglé ne peut plus être modifié, ni annulé', async () => {
      const p = make();
      const { providerRef } = await p.createIntent(intent);
      p.completePayment(providerRef, 'SUCCEEDED');
      expect(() => p.completePayment(providerRef, 'FAILED')).toThrow(PaymentProviderError);
      await expect(p.cancelIntent(providerRef)).rejects.toThrow(PaymentProviderError);
    });

    it('annuler un paiement en attente l’empêche d’aboutir ensuite', async () => {
      const p = make();
      const { providerRef } = await p.createIntent(intent);
      await p.cancelIntent(providerRef);
      expect((await p.getPaymentState(providerRef)).status).toBe('CANCELLED');
      expect(() => p.completePayment(providerRef, 'SUCCEEDED')).toThrow(PaymentProviderError);
    });

    it('un paiement inconnu est refusé', async () => {
      await expect(make().getPaymentState('fake_pay_inconnu')).rejects.toThrow(
        PaymentProviderError,
      );
    });

    it('panne simulée : la création échoue une fois puis fonctionne', async () => {
      const p = make();
      p.failNextIntent = true;
      await expect(p.createIntent(intent)).rejects.toThrow(PaymentProviderError);
      await expect(p.createIntent(intent)).resolves.toBeDefined();
    });
  });

  describe('remboursement', () => {
    async function paid() {
      const p = make();
      const { providerRef } = await p.createIntent(intent);
      p.completePayment(providerRef, 'SUCCEEDED');
      return { p, providerRef };
    }

    it('rembourse un paiement abouti', async () => {
      const { p, providerRef } = await paid();
      const outcome = await p.refund({ providerRef, amountMinor: 800, refundId: 'ref-1' });
      expect(outcome.status).toBe('SUCCEEDED');
      expect(p.refundedMinor(providerRef)).toBe(800);
    });

    it('est IDEMPOTENT : rejouer la même demande ne rembourse pas deux fois', async () => {
      const { p, providerRef } = await paid();
      const first = await p.refund({ providerRef, amountMinor: 800, refundId: 'ref-1' });
      const again = await p.refund({ providerRef, amountMinor: 800, refundId: 'ref-1' });
      expect(again).toEqual(first);
      expect(p.refundedMinor(providerRef)).toBe(800);
    });

    it('refuse de rembourser plus que le solde, ou un paiement non abouti', async () => {
      const { p, providerRef } = await paid();
      await p.refund({ providerRef, amountMinor: 500, refundId: 'ref-1' });
      expect((await p.refund({ providerRef, amountMinor: 500, refundId: 'ref-2' })).status).toBe(
        'FAILED',
      );
      expect(p.refundedMinor(providerRef)).toBe(500);

      const pending = make();
      const created = await pending.createIntent(intent);
      expect(
        (
          await pending.refund({
            providerRef: created.providerRef,
            amountMinor: 800,
            refundId: 'ref-3',
          })
        ).status,
      ).toBe('FAILED');
    });

    it('panne simulée du remboursement', async () => {
      const { p, providerRef } = await paid();
      p.failNextRefund = true;
      const outcome = await p.refund({ providerRef, amountMinor: 800, refundId: 'ref-1' });
      expect(outcome).toMatchObject({ status: 'FAILED', failureReason: expect.any(String) });
      expect(p.refundedMinor(providerRef)).toBe(0);
    });
  });

  describe('authentification des webhooks', () => {
    const signed = (p: FakePaymentProvider, now?: number) =>
      p.buildWebhook('payment.succeeded', 'fake_pay_x', 'evt_1', now);

    it('accepte un webhook correctement signé', () => {
      const p = make();
      const w = signed(p);
      expect(p.parseWebhook(w.rawBody, w.headers)).toMatchObject({
        eventId: 'evt_1',
        providerRef: 'fake_pay_x',
      });
    });

    it('REFUSE un corps modifié après signature (falsification)', () => {
      const p = make();
      const w = signed(p);
      const tampered = Buffer.from(w.rawBody.toString().replace('fake_pay_x', 'fake_pay_y'));
      expect(() => p.parseWebhook(tampered, w.headers)).toThrow(InvalidWebhookSignatureError);
    });

    it('REFUSE une signature absente, mal formée ou fausse', () => {
      const p = make();
      const w = signed(p);
      expect(() => p.parseWebhook(w.rawBody, {})).toThrow(InvalidWebhookSignatureError);
      expect(() => p.parseWebhook(w.rawBody, { 'x-fake-signature': 'n-importe-quoi' })).toThrow(
        InvalidWebhookSignatureError,
      );
      expect(() => p.parseWebhook(w.rawBody, { 'x-fake-signature': 't=1,v1=abc' })).toThrow(
        InvalidWebhookSignatureError,
      );
      expect(() =>
        p.parseWebhook(w.rawBody, {
          'x-fake-signature': `t=${Math.floor(Date.now() / 1000)},v1=${'0'.repeat(64)}`,
        }),
      ).toThrow(InvalidWebhookSignatureError);
    });

    it('REFUSE une signature faite avec un autre secret', () => {
      const other = new FakePaymentProvider(
        loadEnv({
          ...envRaw(),
          PAYMENT_WEBHOOK_SECRET: 'un-autre-secret-de-webhook-32-caracteres',
        }),
      );
      const w = signed(other);
      expect(() => make().parseWebhook(w.rawBody, w.headers)).toThrow(InvalidWebhookSignatureError);
    });

    it('REFUSE un webhook trop ancien (rejeu d’un message intercepté) ou venu du futur', () => {
      const p = make();
      const old = signed(p, Date.now() - 6 * 60_000);
      expect(() => p.parseWebhook(old.rawBody, old.headers)).toThrow(/horodatage/);
      const future = signed(p, Date.now() + 6 * 60_000);
      expect(() => p.parseWebhook(future.rawBody, future.headers)).toThrow(/horodatage/);
      const recent = signed(p, Date.now() - 2 * 60_000);
      expect(() => p.parseWebhook(recent.rawBody, recent.headers)).not.toThrow();
    });

    it('REFUSE un événement signé mais incomplet', () => {
      const p = make();
      const rawBody = Buffer.from(JSON.stringify({ type: 'payment.succeeded' }));
      expect(() => p.parseWebhook(rawBody, p.signatureHeaders(rawBody))).toThrow(/incomplet/);
      const notJson = Buffer.from('pas du json');
      expect(() => p.parseWebhook(notJson, p.signatureHeaders(notJson))).toThrow(/illisible/);
    });
  });
});

function envRaw() {
  return {
    NODE_ENV: 'test',
    WEB_ORIGIN: 'http://localhost:5173',
    DATABASE_URL: 'postgresql://u:p@localhost:5432/x_test',
    JWT_ACCESS_SECRET: 'unit-test-secret-with-more-than-32-characters',
    PAYMENT_WEBHOOK_SECRET: 'unit-test-webhook-secret-123456',
  };
}
