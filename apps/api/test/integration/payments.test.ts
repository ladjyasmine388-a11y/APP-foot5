import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedBaseline } from '../../src/infra/database/baseline.js';
import { BookingsMaintenanceService } from '../../src/modules/bookings/bookings-maintenance.service.js';
import { PaymentsMaintenanceService } from '../../src/modules/payments/payments-maintenance.service.js';
import { PaymentsService } from '../../src/modules/payments/payments.service.js';
import { FakePaymentProvider } from '../../src/modules/payments/providers/fake-payment.provider.js';
import { PaymentProviderError } from '../../src/modules/payments/providers/payment-provider.js';
import {
  type Signup,
  type TestApp,
  bearer,
  createTestApp,
  get,
  post,
  signup,
  verifiedSignup,
} from './app-helper.js';
import { bookingData, prisma, resetDb } from './helpers.js';
import { createVenueWithFields, dayIn, inMinutes, slotAt } from './venue-fixtures.js';

const DATE = dayIn(7);
const iso = (hhmm: string, date = DATE): string => slotAt(date, hhmm).toISOString();

describe('paiements', () => {
  let t: TestApp;
  let fake: FakePaymentProvider;
  let paymentsMaintenance: PaymentsMaintenanceService;
  let bookingsMaintenance: BookingsMaintenanceService;
  let payments: PaymentsService;

  beforeAll(async () => {
    await resetDb();
    await seedBaseline(prisma);
    t = await createTestApp();
    fake = t.app.get(FakePaymentProvider);
    paymentsMaintenance = t.app.get(PaymentsMaintenanceService);
    bookingsMaintenance = t.app.get(BookingsMaintenanceService);
    payments = t.app.get(PaymentsService);
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    t.rateLimits.reset();
    fake.reset();
    // Les événements webhook sont globaux : on repart d'une table vide pour pouvoir les compter.
    await prisma.webhookEvent.deleteMany();
  });

  // ───────────────────────── Outils ─────────────────────────

  async function venue() {
    const { venue: v, fields } = await createVenueWithFields({}, [
      { rules: [{ priceMinor: 4000 }] },
    ]);
    return { venue: v, field: fields[0]!, ids: { fieldId: fields[0]!.id, venueId: v.id } };
  }
  type Venue = Awaited<ReturnType<typeof venue>>;

  const withKey = (user: Signup, key: string = randomUUID()) => ({
    ...bearer(user.accessToken),
    'idempotency-key': key,
  });
  const reserve = (
    user: Signup,
    fieldId: string,
    hhmm: string,
    extra: Record<string, unknown> = {},
  ) => post(t, '/bookings', { fieldId, startsAt: iso(hhmm), ...extra }, withKey(user));
  const pay = (user: Signup, bookingId: string, key?: string) =>
    post(t, `/bookings/${bookingId}/pay`, {}, withKey(user, key));

  /** Joueur + réservation en attente de paiement (acompte 800 DA). */
  async function pending(v: Venue, hhmm = '12:00', extra: Record<string, unknown> = {}) {
    const user = await verifiedSignup(t);
    const booking = (await reserve(user, v.field.id, hhmm, extra)).json();
    return { user, booking };
  }
  /** … avec un paiement ouvert chez le prestataire. */
  async function opened(v: Venue, hhmm = '12:00', extra: Record<string, unknown> = {}) {
    const { user, booking } = await pending(v, hhmm, extra);
    const payment = (await pay(user, booking.id)).json();
    const row = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    return { user, booking, payment, providerRef: row.providerRef! };
  }

  /** Webhook tel que l'enverrait le prestataire (signé), via la VRAIE route HTTP. */
  const deliver = (w: { rawBody: Buffer; headers: Record<string, string> }, provider = 'fake') =>
    t.app.inject({
      method: 'POST',
      url: `/api/v1/webhooks/payments/${provider}`,
      payload: w.rawBody,
      headers: { 'content-type': 'application/json', ...w.headers },
    });
  /** Le payeur règle sur la page du prestataire SANS que le webhook arrive jusqu'à nous (webhook perdu). */
  const payAtProviderSilently = (providerRef: string) =>
    fake.completePayment(providerRef, 'SUCCEEDED');
  const bookingOf = (id: string) => prisma.booking.findUniqueOrThrow({ where: { id } });
  const paymentOf = (id: string) => prisma.payment.findUniqueOrThrow({ where: { id } });
  const publicStatus = async (v: Venue, hhmm: string) => {
    const day = (await get(t, `/venues/${v.venue.slug}/availability?date=${DATE}`)).json();
    return day.fields[0].slots.find((s: { startsAt: string }) => s.startsAt === iso(hhmm))?.status;
  };
  const checkoutPost = (ref: string, action: string) =>
    t.app.inject({
      method: 'POST',
      url: `/api/v1/dev/fake-provider/checkout/${ref}/${action}`,
      headers: { 'content-type': 'text/plain' },
    });

  // ═════════════════════════ Lancer un paiement ═════════════════════════

  describe('POST /bookings/:id/pay', () => {
    it('ouvre le paiement de l’acompte : montant décidé par le serveur, page de paiement du prestataire', async () => {
      const v = await venue();
      const { user, booking } = await pending(v);
      const res = await pay(user, booking.id);

      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({
        bookingId: booking.id,
        status: 'PENDING',
        kind: 'DEPOSIT',
        amountMinor: 800,
        currency: 'DZD',
        checkoutUrl: expect.stringContaining('/api/v1/dev/fake-provider/checkout/fake_pay_'),
        paidAt: null,
      });
      const view = (await get(t, `/bookings/${booking.id}`, user.accessToken)).json();
      expect(view.payment).toMatchObject({ status: 'PENDING', checkoutUrl: expect.any(String) });
    });

    it('paiement 100 % en ligne : le total est dû', async () => {
      const v = await venue();
      const { user, booking } = await pending(v, '12:00', { paymentMode: 'FULL_ONLINE' });
      expect((await pay(user, booking.id)).json()).toMatchObject({
        kind: 'FULL',
        amountMinor: 4000,
      });
    });

    it('ne divulgue ni la référence du prestataire, ni sa réponse brute, ni la clé d’idempotence', async () => {
      const v = await venue();
      const { user, booking } = await pending(v);
      const res = await pay(user, booking.id);
      expect(res.body).not.toMatch(/providerRef|rawPayload|idempotencyKey|"provider"/);
      expect(Object.keys(res.json()).sort()).toEqual([
        'amountMinor',
        'bookingId',
        'checkoutUrl',
        'createdAt',
        'currency',
        'failureReason',
        'id',
        'kind',
        'paidAt',
        'status',
      ]);
    });

    it('exige Idempotency-Key, et REFUSE tout champ (le montant ne vient jamais du client)', async () => {
      const v = await venue();
      const { user, booking } = await pending(v);
      expect(
        (await post(t, `/bookings/${booking.id}/pay`, {}, bearer(user.accessToken))).statusCode,
      ).toBe(400);
      for (const extra of [
        { amountMinor: 1 },
        { amount: 1 },
        { providerRef: 'x' },
        { status: 'SUCCEEDED' },
      ]) {
        const res = await post(t, `/bookings/${booking.id}/pay`, extra, withKey(user));
        expect(res.statusCode, JSON.stringify(extra)).toBe(400);
      }
      expect(await prisma.payment.count({ where: { bookingId: booking.id } })).toBe(0);
    });

    it('rejouer la même requête rend le même paiement ; une autre clé rend la même page tant qu’un paiement est ouvert', async () => {
      const v = await venue();
      const { user, booking } = await pending(v);
      const key = randomUUID();
      const first = await pay(user, booking.id, key);
      const replay = await pay(user, booking.id, key);
      const otherKey = await pay(user, booking.id);

      expect(replay.json()).toEqual(first.json());
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(otherKey.json().id).toBe(first.json().id);
      expect(await prisma.payment.count({ where: { bookingId: booking.id } })).toBe(1);
    });

    it('6 demandes SIMULTANÉES : un seul paiement ouvert, jamais deux pages de paiement', async () => {
      const v = await venue();
      const { user, booking } = await pending(v);
      const results = await Promise.all(Array.from({ length: 6 }, () => pay(user, booking.id)));

      expect(
        await prisma.payment.count({
          where: { bookingId: booking.id, status: { in: ['INITIATED', 'PENDING'] } },
        }),
      ).toBe(1);
      const ok = results.filter((r) => r.statusCode === 201);
      expect(ok.length).toBeGreaterThanOrEqual(1);
      expect(new Set(ok.map((r) => r.json().id)).size).toBe(1);
      for (const r of results) expect([201, 409]).toContain(r.statusCode);
    });

    it('la base refuse deux paiements en cours pour une réservation, même en contournant le code', async () => {
      const v = await venue();
      const { booking } = await opened(v);
      await expect(
        prisma.payment.create({
          data: {
            bookingId: booking.id,
            provider: 'fake',
            kind: 'DEPOSIT',
            amountMinor: 800,
            status: 'PENDING',
            idempotencyKey: randomUUID(),
          },
        }),
      ).rejects.toThrow();
    });

    it('ne marche que pour son propre paiement : 404 pour un tiers, 401 sans jeton, 403 sans email vérifié', async () => {
      const v = await venue();
      const { booking } = await pending(v);
      const stranger = await verifiedSignup(t);
      expect((await pay(stranger, booking.id)).statusCode).toBe(404);
      expect(
        (await post(t, `/bookings/${booking.id}/pay`, {}, { 'idempotency-key': randomUUID() }))
          .statusCode,
      ).toBe(401);
      expect((await pay(stranger, randomUUID())).statusCode).toBe(404);
      const unverified = await signup(t);
      expect((await pay(unverified, booking.id)).statusCode).toBe(403);
    });

    it.each([
      [
        'annulée',
        async (id: string) =>
          prisma.booking.update({
            where: { id },
            data: { status: 'CANCELLED', holdExpiresAt: null },
          }),
      ],
      [
        'déjà confirmée',
        async (id: string) =>
          prisma.booking.update({
            where: { id },
            data: { status: 'CONFIRMED', holdExpiresAt: null },
          }),
      ],
      [
        'au délai de paiement dépassé',
        async (id: string) =>
          prisma.booking.update({ where: { id }, data: { holdExpiresAt: inMinutes(-1) } }),
      ],
    ])('refuse de payer une réservation %s (409 BOOKING_NOT_PAYABLE)', async (_label, mutate) => {
      const v = await venue();
      const { user, booking } = await pending(v);
      await mutate(booking.id);
      const res = await pay(user, booking.id);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('BOOKING_NOT_PAYABLE');
      expect(await prisma.payment.count({ where: { bookingId: booking.id } })).toBe(0);
    });

    it('prolonge le verrou pendant le règlement, mais jamais au-delà de 3 fois sa durée de base', async () => {
      const v = await venue();
      const { user, booking } = await pending(v);
      // Il ne reste qu'une minute : le paiement prolonge le verrou à ~10 minutes
      await prisma.booking.update({
        where: { id: booking.id },
        data: { holdExpiresAt: inMinutes(1) },
      });
      await pay(user, booking.id);
      const extended = (await bookingOf(booking.id)).holdExpiresAt!.getTime() - Date.now();
      expect(extended).toBeGreaterThan(9 * 60_000);

      // Réservation créée il y a 28 minutes : la prolongation est plafonnée à 30 minutes depuis la création
      const second = await pending(v, '14:00');
      await prisma.booking.update({
        where: { id: second.booking.id },
        data: { createdAt: new Date(Date.now() - 28 * 60_000), holdExpiresAt: inMinutes(1) },
      });
      await pay(second.user, second.booking.id);
      const capped = (await bookingOf(second.booking.id)).holdExpiresAt!.getTime() - Date.now();
      expect(capped).toBeLessThan(2.5 * 60_000);
    });

    it('si le prestataire est en panne : 502, paiement marqué échoué, nouvel essai possible', async () => {
      const v = await venue();
      const { user, booking } = await pending(v);
      fake.failNextIntent = true;
      const down = await pay(user, booking.id);
      expect(down.statusCode).toBe(502);
      expect(down.json().error.code).toBe('PAYMENT_PROVIDER_ERROR');
      expect(await prisma.payment.findMany({ where: { bookingId: booking.id } })).toEqual([
        expect.objectContaining({ status: 'FAILED' }),
      ]);

      const retry = await pay(user, booking.id);
      expect(retry.statusCode).toBe(201);
      expect(retry.json().status).toBe('PENDING');
    });
  });

  // ═════════════════════════ Parcours complet ═════════════════════════

  describe('le payeur règle sur la page du prestataire', () => {
    it('PARCOURS COMPLET : page de paiement → règlement → webhook signé → vérification serveur → réservation confirmée', async () => {
      const v = await venue();
      const { user, booking, payment, providerRef } = await opened(v);

      const page = await t.app.inject({
        method: 'GET',
        url: `/api/v1/dev/fake-provider/checkout/${providerRef}`,
      });
      expect(page.statusCode).toBe(200);
      expect(page.headers['content-type']).toContain('text/html');
      expect(page.body).toContain('SIMULATION');
      expect(page.body).toContain('800');

      const paid = await checkoutPost(providerRef, 'pay');
      expect(paid.statusCode).toBe(303);
      expect(paid.headers.location).toContain(
        `/bookings/${booking.id}/payment?paymentId=${payment.id}`,
      );

      expect(await paymentOf(payment.id)).toMatchObject({
        status: 'SUCCEEDED',
        paidAt: expect.any(Date),
      });
      expect(await bookingOf(booking.id)).toMatchObject({
        status: 'CONFIRMED',
        holdExpiresAt: null,
      });
      expect(await prisma.webhookEvent.findMany({ where: { provider: 'fake' } })).toEqual([
        expect.objectContaining({ status: 'PROCESSED', type: 'payment.succeeded' }),
      ]);

      const view = (await get(t, `/bookings/${booking.id}`, user.accessToken)).json();
      expect(view).toMatchObject({
        status: 'CONFIRMED',
        paidOnlineMinor: 800,
        dueOnSiteMinor: 3200,
        holdExpiresAt: null,
      });
      expect(view.payment).toMatchObject({ status: 'SUCCEEDED', checkoutUrl: null });
      expect(await publicStatus(v, '12:00')).toBe('UNAVAILABLE');
    });

    it('paiement 100 % en ligne : plus rien à régler sur place', async () => {
      const v = await venue();
      const { user, booking, providerRef } = await opened(v, '12:00', {
        paymentMode: 'FULL_ONLINE',
      });
      await checkoutPost(providerRef, 'pay');
      const view = (await get(t, `/bookings/${booking.id}`, user.accessToken)).json();
      expect(view).toMatchObject({ status: 'CONFIRMED', paidOnlineMinor: 4000, dueOnSiteMinor: 0 });
    });

    it('la REDIRECTION n’est pas une preuve : revenir sur le site sans avoir payé ne confirme rien', async () => {
      const v = await venue();
      const { user, booking, payment } = await opened(v);
      // Le navigateur « revient » sur la page de retour, mais le payeur n'a rien réglé chez le prestataire.
      const status = await get(t, `/payments/${payment.id}`, user.accessToken);
      expect(status.json().status).toBe('PENDING');
      expect((await bookingOf(booking.id)).status).toBe('PENDING_PAYMENT');
    });

    it('si le webhook est perdu, la page de retour fait INTERROGER le prestataire par le serveur et confirme', async () => {
      const v = await venue();
      const { user, booking, payment, providerRef } = await opened(v);
      payAtProviderSilently(providerRef); // réglé chez le prestataire, aucun webhook reçu

      expect((await bookingOf(booking.id)).status).toBe('PENDING_PAYMENT');
      const status = await get(t, `/payments/${payment.id}`, user.accessToken);
      expect(status.json()).toMatchObject({ status: 'SUCCEEDED', paidAt: expect.any(String) });
      expect((await bookingOf(booking.id)).status).toBe('CONFIRMED');
    });

    it('un échec de paiement n’annule pas la réservation : le joueur peut réessayer et réussir', async () => {
      const v = await venue();
      const { user, booking, payment, providerRef } = await opened(v);
      await checkoutPost(providerRef, 'fail');

      expect(await paymentOf(payment.id)).toMatchObject({
        status: 'FAILED',
        failureReason: expect.stringContaining('refusé'),
      });
      expect((await bookingOf(booking.id)).status).toBe('PENDING_PAYMENT');

      const retry = (await pay(user, booking.id)).json();
      expect(retry.id).not.toBe(payment.id);
      const retryRef = (await paymentOf(retry.id)).providerRef!;
      await checkoutPost(retryRef, 'pay');
      expect((await bookingOf(booking.id)).status).toBe('CONFIRMED');
      expect(
        (
          await prisma.payment.findMany({
            where: { bookingId: booking.id },
            orderBy: { createdAt: 'asc' },
          })
        ).map((p) => p.status),
      ).toEqual(['FAILED', 'SUCCEEDED']);
    });

    it('un payeur qui abandonne laisse la réservation en attente, relançable', async () => {
      const v = await venue();
      const { user, booking, payment, providerRef } = await opened(v);
      const res = await checkoutPost(providerRef, 'cancel');
      expect(res.headers.location).toContain(`/bookings/${booking.id}`);
      expect((await paymentOf(payment.id)).status).toBe('CANCELLED');
      expect((await bookingOf(booking.id)).status).toBe('PENDING_PAYMENT');
      expect((await pay(user, booking.id)).statusCode).toBe(201);
    });

    it('une page de paiement déjà réglée ne se paie pas deux fois', async () => {
      const v = await venue();
      const { booking, providerRef } = await opened(v);
      await checkoutPost(providerRef, 'pay');
      await checkoutPost(providerRef, 'pay');
      await checkoutPost(providerRef, 'fail');
      expect(
        await prisma.payment.count({ where: { bookingId: booking.id, status: 'SUCCEEDED' } }),
      ).toBe(1);
      expect(
        (
          await t.app.inject({
            method: 'GET',
            url: `/api/v1/dev/fake-provider/checkout/${providerRef}`,
          })
        ).body,
      ).toContain('déjà');
    });

    it('la page de paiement simulée échappe son contenu et répond 404 pour une référence inconnue', async () => {
      expect(
        (
          await t.app.inject({
            method: 'GET',
            url: '/api/v1/dev/fake-provider/checkout/fake_pay_inconnu',
          })
        ).statusCode,
      ).toBe(404);
      expect((await checkoutPost('fake_pay_inconnu', 'pay')).statusCode).toBe(404);
      const v = await venue();
      const { providerRef } = await opened(v);
      expect((await checkoutPost(providerRef, 'piratage')).statusCode).toBe(404);
    });
  });

  // ═════════════════════════ Webhooks ═════════════════════════

  describe('POST /webhooks/payments/:provider', () => {
    it('REFUSE (401) un webhook sans signature, falsifié ou signé avec un autre secret — et n’enregistre rien', async () => {
      const v = await venue();
      const { booking, providerRef } = await opened(v);
      const good = fake.buildWebhook('payment.succeeded', providerRef);

      const unsigned = await deliver({ rawBody: good.rawBody, headers: {} });
      const tampered = await deliver({
        rawBody: Buffer.from(good.rawBody.toString().replace(providerRef, 'fake_pay_autre')),
        headers: good.headers,
      });
      const wrongKey = await deliver({
        rawBody: good.rawBody,
        headers: { 'x-fake-signature': `t=${Math.floor(Date.now() / 1000)},v1=${'a'.repeat(64)}` },
      });
      for (const res of [unsigned, tampered, wrongKey]) {
        expect(res.statusCode).toBe(401);
        expect(res.json().error.code).toBe('INVALID_WEBHOOK_SIGNATURE');
      }
      expect(await prisma.webhookEvent.count()).toBe(0);
      expect((await bookingOf(booking.id)).status).toBe('PENDING_PAYMENT');
    });

    it('REFUSE un webhook trop ancien (rejeu d’un message intercepté)', async () => {
      const v = await venue();
      const { providerRef } = await opened(v);
      const old = fake.buildWebhook(
        'payment.succeeded',
        providerRef,
        'evt_old',
        Date.now() - 10 * 60_000,
      );
      const res = await deliver(old);
      expect(res.statusCode).toBe(401);
    });

    it('un webhook correctement signé MAIS MENSONGER ne confirme rien : la vérité vient du prestataire', async () => {
      const v = await venue();
      const { booking, payment, providerRef } = await opened(v);
      // Le payeur n'a RIEN réglé, mais le message prétend « payment.succeeded »
      const lie = fake.buildWebhook('payment.succeeded', providerRef);
      const res = await deliver(lie);

      expect(res.statusCode).toBe(200);
      expect(await paymentOf(payment.id)).toMatchObject({ status: 'PENDING', paidAt: null });
      expect((await bookingOf(booking.id)).status).toBe('PENDING_PAYMENT');
    });

    it('un webhook authentique confirme ; la même livraison reçue deux fois est acquittée sans rien refaire', async () => {
      const v = await venue();
      const { booking, providerRef } = await opened(v);
      const w = payAtProviderSilently(providerRef);

      const first = await deliver(w);
      const second = await deliver(w);
      expect(first.json()).toEqual({ received: true, result: 'processed' });
      expect(second.json()).toEqual({ received: true, result: 'duplicate' });
      expect((await bookingOf(booking.id)).status).toBe('CONFIRMED');
      expect(await prisma.webhookEvent.count()).toBe(1);
    });

    it('5 livraisons SIMULTANÉES du même événement : réservation confirmée une seule fois', async () => {
      const v = await venue();
      const { booking, payment, providerRef } = await opened(v);
      const w = payAtProviderSilently(providerRef);
      const results = await Promise.all(Array.from({ length: 5 }, () => deliver(w)));

      for (const r of results) expect(r.statusCode).toBe(200);
      expect((await bookingOf(booking.id)).status).toBe('CONFIRMED');
      expect(await prisma.webhookEvent.count()).toBe(1);
      expect(await prisma.payment.count({ where: { id: payment.id, status: 'SUCCEEDED' } })).toBe(
        1,
      );
      expect(await prisma.refund.count({ where: { bookingId: booking.id } })).toBe(0);
    });

    it('acquitte sans effet un paiement inconnu, un type d’événement non géré, mais refuse un prestataire inconnu (404)', async () => {
      const v = await venue();
      const { providerRef } = await opened(v);
      const unknown = await deliver(fake.buildWebhook('payment.succeeded', 'fake_pay_inconnu'));
      expect(unknown.json().result).toBe('ignored');

      const refundEvent = await deliver(fake.buildWebhook('refund.succeeded', providerRef));
      expect(refundEvent.json().result).toBe('ignored');
      expect(
        (await prisma.webhookEvent.findMany({ orderBy: { receivedAt: 'asc' } })).map(
          (e) => e.status,
        ),
      ).toEqual(['IGNORED', 'IGNORED']);

      expect(
        (await deliver(fake.buildWebhook('payment.succeeded', providerRef), 'autre-prestataire'))
          .statusCode,
      ).toBe(404);
    });

    it('exige un corps JSON', async () => {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/v1/webhooks/payments/fake',
        payload: 'texte',
        headers: { 'content-type': 'text/plain' },
      });
      expect([400, 415]).toContain(res.statusCode);
    });

    it('MONTANT DIFFÉRENT de celui attendu : rien n’est confirmé, l’anomalie est auditée et définitive (pas de nouvelle tentative)', async () => {
      const v = await venue();
      const { booking, payment, providerRef } = await opened(v);
      fake.forceState(providerRef, { status: 'SUCCEEDED', amountMinor: 100 }); // le prestataire dit « réglé… 100 DA au lieu de 800 »

      const res = await deliver(fake.buildWebhook('payment.succeeded', providerRef));
      expect(res.json().result).toBe('rejected');
      expect(await paymentOf(payment.id)).toMatchObject({ status: 'PENDING', paidAt: null });
      expect((await bookingOf(booking.id)).status).toBe('PENDING_PAYMENT');
      expect((await prisma.webhookEvent.findFirstOrThrow()).status).toBe('FAILED');
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { action: 'payment.amount_mismatch', entityId: payment.id },
      });
      expect(audit).toMatchObject({
        actorRole: 'SYSTEM',
        before: { amountMinor: 800 },
        after: { amountMinor: 100 },
      });
    });

    it('DEVISE différente : même refus', async () => {
      const v = await venue();
      const { booking, providerRef } = await opened(v);
      fake.forceState(providerRef, { status: 'SUCCEEDED', currency: 'EUR' });
      expect(
        (await deliver(fake.buildWebhook('payment.succeeded', providerRef))).json().result,
      ).toBe('rejected');
      expect((await bookingOf(booking.id)).status).toBe('PENDING_PAYMENT');
    });

    it('panne du prestataire pendant le traitement : réponse 500 (il réessaiera), événement rejouable, puis succès', async () => {
      const v = await venue();
      const { booking, providerRef } = await opened(v);
      const w = payAtProviderSilently(providerRef);

      const original = fake.getPaymentState.bind(fake);
      fake.getPaymentState = () =>
        Promise.reject(new PaymentProviderError('Prestataire indisponible'));
      let outage;
      try {
        outage = await deliver(w);
      } finally {
        fake.getPaymentState = original;
      }
      expect(outage.statusCode).toBe(500);
      expect((await prisma.webhookEvent.findFirstOrThrow()).status).toBe('FAILED');
      expect((await bookingOf(booking.id)).status).toBe('PENDING_PAYMENT');

      const retry = await deliver(w); // le prestataire renvoie le MÊME événement
      expect(retry.json().result).toBe('processed');
      expect((await bookingOf(booking.id)).status).toBe('CONFIRMED');
      expect(await prisma.webhookEvent.count()).toBe(1);
    });
  });

  // ═════════════════════════ Paiements tardifs et doublons ═════════════════════════

  describe('cas limites', () => {
    it('paiement arrivé APRÈS l’expiration du verrou, créneau toujours libre : le client garde son créneau', async () => {
      const v = await venue();
      const { booking, providerRef } = await opened(v);
      await prisma.booking.update({
        where: { id: booking.id },
        data: { holdExpiresAt: inMinutes(-1) },
      }); // verrou dépassé, pas encore nettoyé
      await deliver(payAtProviderSilently(providerRef));
      expect((await bookingOf(booking.id)).status).toBe('CONFIRMED');
    });

    it('même chose si le nettoyage est déjà passé (réservation EXPIRED) : elle est réactivée', async () => {
      const v = await venue();
      const { booking, providerRef } = await opened(v);
      await prisma.booking.update({
        where: { id: booking.id },
        data: { holdExpiresAt: inMinutes(-1) },
      });
      await bookingsMaintenance.runOnce();
      expect((await bookingOf(booking.id)).status).toBe('EXPIRED');

      // Le prestataire avait déjà été prévenu de l'expiration → on simule un règlement arrivé juste avant
      fake.forceState(providerRef, { status: 'SUCCEEDED' });
      await deliver(fake.buildWebhook('payment.succeeded', providerRef));
      expect((await bookingOf(booking.id)).status).toBe('CONFIRMED');
    });

    it('paiement arrivé APRÈS que le créneau a été repris par un autre client : remboursement AUTOMATIQUE intégral', async () => {
      const v = await venue();
      const { booking, payment, providerRef } = await opened(v);
      await prisma.booking.update({
        where: { id: booking.id },
        data: { holdExpiresAt: inMinutes(-1) },
      });
      const other = await verifiedSignup(t);
      expect((await reserve(other, v.field.id, '12:00')).statusCode).toBe(201); // l'autre prend le créneau
      expect((await bookingOf(booking.id)).status).toBe('EXPIRED');

      fake.forceState(providerRef, { status: 'SUCCEEDED' }); // …mais le premier payeur règle quand même
      await deliver(fake.buildWebhook('payment.succeeded', providerRef));

      expect((await bookingOf(booking.id)).status).toBe('EXPIRED'); // pas de réservation fantôme
      expect(await paymentOf(payment.id)).toMatchObject({ status: 'REFUNDED' });
      const refund = await prisma.refund.findFirstOrThrow({ where: { paymentId: payment.id } });
      expect(refund).toMatchObject({
        status: 'SUCCEEDED',
        amountMinor: 800,
        reason: expect.stringContaining('pris par un autre client'),
      });
      expect(fake.refundedMinor(providerRef)).toBe(800);
      expect(
        await prisma.auditLog.count({
          where: { action: 'payment.auto_refund', entityId: payment.id },
        }),
      ).toBe(1);
      expect(
        await prisma.booking.count({ where: { fieldId: v.field.id, status: 'PENDING_PAYMENT' } }),
      ).toBe(1); // celle de l'autre client, intacte
    });

    it('annuler la réservation FERME le paiement chez le prestataire : le payeur ne peut plus régler', async () => {
      const v = await venue();
      const { user, booking, payment, providerRef } = await opened(v);
      const cancel = await post(t, `/bookings/${booking.id}/cancel`, {}, bearer(user.accessToken));
      expect(cancel.statusCode).toBe(200);

      expect(await paymentOf(payment.id)).toMatchObject({ status: 'CANCELLED' });
      expect((await fake.getPaymentState(providerRef)).status).toBe('CANCELLED');
      await checkoutPost(providerRef, 'pay'); // le payeur tente quand même
      expect((await bookingOf(booking.id)).status).toBe('CANCELLED');
      expect(
        await prisma.payment.count({ where: { bookingId: booking.id, status: 'SUCCEEDED' } }),
      ).toBe(0);
    });

    it('si le prestataire n’a pas pu fermer le paiement et qu’il est réglé après l’annulation : remboursement automatique', async () => {
      const v = await venue();
      const { user, booking, payment, providerRef } = await opened(v);
      const original = fake.cancelIntent.bind(fake);
      fake.cancelIntent = () => Promise.reject(new PaymentProviderError('Annulation impossible'));
      try {
        await post(t, `/bookings/${booking.id}/cancel`, {}, bearer(user.accessToken));
      } finally {
        fake.cancelIntent = original;
      }
      expect((await bookingOf(booking.id)).status).toBe('CANCELLED');

      await deliver(payAtProviderSilently(providerRef)); // le payeur règle quand même

      expect((await bookingOf(booking.id)).status).toBe('CANCELLED');
      expect(await paymentOf(payment.id)).toMatchObject({ status: 'REFUNDED' });
      expect(fake.refundedMinor(providerRef)).toBe(800);
    });

    it('PAIEMENT EN DOUBLE : un ancien paiement réglé tardivement, après le nouveau, est remboursé', async () => {
      const v = await venue();
      const { user, booking, payment: first, providerRef: firstRef } = await opened(v);
      // Le premier paiement est considéré abandonné côté serveur (ex. délai dépassé) ; le joueur en relance un second.
      await prisma.payment.update({
        where: { id: first.id },
        data: { status: 'FAILED', failureReason: 'Abandonné' },
      });
      const second = (await pay(user, booking.id)).json();
      const secondRef = (await paymentOf(second.id)).providerRef!;
      await deliver(payAtProviderSilently(secondRef));
      expect((await bookingOf(booking.id)).status).toBe('CONFIRMED');

      // Puis le premier paiement aboutit finalement chez le prestataire : le client a payé DEUX fois.
      await deliver(payAtProviderSilently(firstRef));

      expect(await paymentOf(second.id)).toMatchObject({ status: 'SUCCEEDED' }); // le premier réglé reste la référence
      expect(await paymentOf(first.id)).toMatchObject({ status: 'REFUNDED' }); // le doublon est remboursé
      expect(fake.refundedMinor(firstRef)).toBe(800);
      expect(fake.refundedMinor(secondRef)).toBe(0);
      expect((await bookingOf(booking.id)).status).toBe('CONFIRMED');
    });
  });

  // ═════════════════════════ Remboursements ═════════════════════════

  describe('remboursements', () => {
    async function paidBooking(v: Venue, hhmm = '12:00') {
      const o = await opened(v, hhmm);
      await checkoutPost(o.providerRef, 'pay');
      return o;
    }
    const cancel = (user: Signup, id: string) =>
      post(t, `/bookings/${id}/cancel`, {}, bearer(user.accessToken));

    it('annulation gratuite (≥ 24 h) : remboursée IMMÉDIATEMENT chez le prestataire', async () => {
      const v = await venue();
      const { user, booking, payment, providerRef } = await paidBooking(v);
      const res = await cancel(user, booking.id);

      expect(res.json().refund).toEqual({ eligible: true, amountMinor: 800 });
      const refund = await prisma.refund.findFirstOrThrow({ where: { bookingId: booking.id } });
      expect(refund).toMatchObject({
        status: 'SUCCEEDED',
        amountMinor: 800,
        providerRef: expect.stringMatching(/^fake_ref_/),
        processedAt: expect.any(Date),
      });
      expect(await paymentOf(payment.id)).toMatchObject({ status: 'REFUNDED' });
      expect(fake.refundedMinor(providerRef)).toBe(800);
      expect((await get(t, `/bookings/${booking.id}`, user.accessToken)).json()).toMatchObject({
        status: 'CANCELLED',
      });
    });

    it('rejouer le traitement ne rembourse jamais deux fois (idempotent)', async () => {
      const v = await venue();
      const { user, booking, providerRef } = await paidBooking(v);
      await cancel(user, booking.id);
      const refund = await prisma.refund.findFirstOrThrow({ where: { bookingId: booking.id } });

      await payments.processRefund(refund.id);
      await payments.processRefund(refund.id, { retryStuck: true });
      await paymentsMaintenance.runOnce();
      expect(fake.refundedMinor(providerRef)).toBe(800);
      expect(await prisma.refund.count({ where: { bookingId: booking.id } })).toBe(1);
    });

    it('annulation tardive (< 24 h) : l’acompte reste acquis, aucun remboursement', async () => {
      const v = await venue();
      const user = await verifiedSignup(t);
      const start = new Date(Date.now() + 5 * 3_600_000);
      start.setMinutes(0, 0, 0);
      const booking = await prisma.booking.create({
        data: bookingData(v.ids, { userId: user.userId, start }),
      });
      const payment = await prisma.payment.create({
        data: {
          bookingId: booking.id,
          provider: 'fake',
          kind: 'DEPOSIT',
          amountMinor: 800,
          status: 'SUCCEEDED',
          paidAt: new Date(),
          providerRef: 'fake_pay_x',
          idempotencyKey: randomUUID(),
        },
      });
      const res = await cancel(user, booking.id);
      expect(res.json().refund).toEqual({ eligible: false, amountMinor: 0 });
      expect(await prisma.refund.count({ where: { bookingId: booking.id } })).toBe(0);
      expect((await paymentOf(payment.id)).status).toBe('SUCCEEDED');
    });

    it('annulation par le COMPLEXE : remboursement intégral exécuté, même à quelques heures du match', async () => {
      const v = await venue();
      const user = await verifiedSignup(t);
      const manager = await verifiedSignup(t);
      await prisma.venueStaff.create({
        data: { venueId: v.venue.id, userId: manager.userId, role: 'MANAGER' },
      });
      const start = new Date(Date.now() + 3 * 3_600_000);
      start.setMinutes(0, 0, 0);
      const booking = await prisma.booking.create({
        data: bookingData(v.ids, { userId: user.userId, start }),
      });
      // Un vrai paiement chez le prestataire simulé
      const intent = await fake.createIntent({
        paymentId: 'p-1',
        bookingReference: booking.reference,
        amountMinor: 800,
        currency: 'DZD',
        description: 'x',
        customer: { email: 'a@b.co', phone: '+213550000000' },
        returnUrl: 'http://x',
        cancelUrl: 'http://x',
      });
      fake.completePayment(intent.providerRef, 'SUCCEEDED');
      const payment = await prisma.payment.create({
        data: {
          bookingId: booking.id,
          provider: 'fake',
          providerRef: intent.providerRef,
          kind: 'DEPOSIT',
          amountMinor: 800,
          status: 'SUCCEEDED',
          paidAt: new Date(),
          idempotencyKey: randomUUID(),
        },
      });

      const res = await post(
        t,
        `/manage/venues/${v.venue.id}/bookings/${booking.id}/cancel`,
        { reason: 'Terrain inondé' },
        bearer(manager.accessToken),
      );
      expect(res.json().refundRequestedMinor).toBe(800);
      expect(await paymentOf(payment.id)).toMatchObject({ status: 'REFUNDED' });
      expect(fake.refundedMinor(intent.providerRef)).toBe(800);
    });

    it('échec du remboursement chez le prestataire : demande en échec, paiement inchangé, motif d’origine conservé, audité', async () => {
      const v = await venue();
      const { user, booking, payment } = await paidBooking(v);
      fake.failNextRefund = true;
      await cancel(user, booking.id);

      const refund = await prisma.refund.findFirstOrThrow({ where: { bookingId: booking.id } });
      expect(refund.status).toBe('FAILED');
      expect(refund.reason).toContain('Annulation par le joueur');
      expect(refund.reason).toContain('ÉCHEC');
      expect((await paymentOf(payment.id)).status).toBe('SUCCEEDED'); // l'argent n'a pas bougé
      expect(
        await prisma.auditLog.count({ where: { action: 'refund.failed', entityId: refund.id } }),
      ).toBe(1);
    });

    describe('décisions de l’administration', () => {
      async function admin() {
        const user = await verifiedSignup(t);
        await prisma.user.update({ where: { id: user.userId }, data: { platformRole: 'ADMIN' } });
        return user;
      }

      it('relancer un remboursement en échec : nouvelle demande exécutée une seule fois, historique conservé, audité', async () => {
        const v = await venue();
        const { user, booking, payment, providerRef } = await paidBooking(v);
        fake.failNextRefund = true;
        await cancel(user, booking.id);
        const failed = await prisma.refund.findFirstOrThrow({ where: { bookingId: booking.id } });
        expect(failed.status).toBe('FAILED');
        const boss = await admin();

        expect((await post(t, `/admin/refunds/${failed.id}/retry`, undefined, bearer(user.accessToken))).statusCode).toBe(403); // pas administrateur
        const retry = await post(t, `/admin/refunds/${failed.id}/retry`, undefined, bearer(boss.accessToken));
        expect(retry.statusCode).toBe(201);

        const second = await prisma.refund.findUniqueOrThrow({ where: { id: retry.json().refundId } });
        expect(second).toMatchObject({ status: 'SUCCEEDED', amountMinor: 800, requestedById: boss.userId });
        expect(second.reason).toContain(failed.id);
        expect((await prisma.refund.findUniqueOrThrow({ where: { id: failed.id } })).status).toBe('FAILED'); // historique conservé
        expect((await paymentOf(payment.id)).status).toBe('REFUNDED');
        expect(fake.refundedMinor(providerRef)).toBe(800);
        expect(await prisma.auditLog.count({ where: { action: 'refund.retry', entityId: failed.id } })).toBe(1);
        // Déjà réglé : une seconde relance de l'ancien échec est refusée, rien n'est remboursé deux fois.
        expect((await post(t, `/admin/refunds/${failed.id}/retry`, undefined, bearer(boss.accessToken))).statusCode).toBe(409);
        expect(fake.refundedMinor(providerRef)).toBe(800);
        expect((await post(t, `/admin/refunds/${second.id}/retry`, undefined, bearer(boss.accessToken))).statusCode).toBe(409); // réussi : rien à relancer
        expect((await post(t, '/admin/refunds/00000000-0000-4000-8000-000000000000/retry', undefined, bearer(boss.accessToken))).statusCode).toBe(404);
      });

      it('rembourser une réservation payée sur décision de l’administration : montant exact, réservation intacte, pas de double remboursement', async () => {
        const v = await venue();
        const { booking, payment, providerRef } = await paidBooking(v);
        const boss = await admin();

        const res = await post(t, `/admin/bookings/${booking.id}/refund`, { reason: 'Litige : terrain indisponible' }, bearer(boss.accessToken));
        expect(res.statusCode).toBe(201);
        expect(res.json().totalMinor).toBe(800);
        const refund = await prisma.refund.findFirstOrThrow({ where: { bookingId: booking.id } });
        expect(refund).toMatchObject({ status: 'SUCCEEDED', amountMinor: 800, requestedById: boss.userId });
        expect(refund.reason).toContain('Litige');
        expect((await paymentOf(payment.id)).status).toBe('REFUNDED');
        expect(fake.refundedMinor(providerRef)).toBe(800);
        expect((await bookingOf(booking.id)).status).toBe('CONFIRMED'); // la réservation n'est pas annulée pour autant

        const again = await post(t, `/admin/bookings/${booking.id}/refund`, { reason: 'Deuxième tentative' }, bearer(boss.accessToken));
        expect(again.statusCode).toBe(409);
        expect(fake.refundedMinor(providerRef)).toBe(800);
        expect((await post(t, `/admin/bookings/${booking.id}/refund`, {}, bearer(boss.accessToken))).statusCode).toBe(400); // motif obligatoire
      });
    });

    it('panne TEMPORAIRE du prestataire : la demande est remise en file, puis exécutée par la maintenance', async () => {
      const v = await venue();
      const { user, booking, payment, providerRef } = await paidBooking(v);
      const original = fake.refund.bind(fake);
      fake.refund = () => Promise.reject(new PaymentProviderError('Prestataire indisponible'));
      try {
        await cancel(user, booking.id);
      } finally {
        fake.refund = original;
      }
      const refund = await prisma.refund.findFirstOrThrow({ where: { bookingId: booking.id } });
      expect(refund.status).toBe('REQUESTED');
      expect(fake.refundedMinor(providerRef)).toBe(0);

      const result = await paymentsMaintenance.runOnce();
      expect(result.refundsProcessed).toBeGreaterThanOrEqual(1);
      expect((await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } })).status).toBe(
        'SUCCEEDED',
      );
      expect((await paymentOf(payment.id)).status).toBe('REFUNDED');
      expect(fake.refundedMinor(providerRef)).toBe(800);
    });

    it('un remboursement resté « en cours » après un plantage est repris, sans double remboursement', async () => {
      const v = await venue();
      const { user, booking, payment, providerRef } = await paidBooking(v);
      await cancel(user, booking.id); // remboursé une première fois
      const done = await prisma.refund.findFirstOrThrow({ where: { bookingId: booking.id } });
      // Simule : le prestataire a remboursé, mais le serveur a planté avant d'enregistrer le résultat.
      await prisma.refund.update({
        where: { id: done.id },
        data: {
          status: 'PROCESSING',
          createdAt: new Date(Date.now() - 30 * 60_000),
          processedAt: null,
        },
      });
      await prisma.payment.update({ where: { id: payment.id }, data: { status: 'SUCCEEDED' } });

      await paymentsMaintenance.runOnce();
      expect((await prisma.refund.findUniqueOrThrow({ where: { id: done.id } })).status).toBe(
        'SUCCEEDED',
      );
      expect((await paymentOf(payment.id)).status).toBe('REFUNDED');
      expect(fake.refundedMinor(providerRef)).toBe(800); // pas 1 600
    });

    it('abandonne une demande restée en échec plus de 24 h et alerte (audit)', async () => {
      const v = await venue();
      const { booking, payment } = await paidBooking(v);
      const refund = await prisma.refund.create({
        data: {
          paymentId: payment.id,
          bookingId: booking.id,
          amountMinor: 800,
          status: 'REQUESTED',
          reason: 'Test',
          createdAt: new Date(Date.now() - 25 * 3_600_000),
        },
      });
      const result = await paymentsMaintenance.runOnce();
      expect(result.refundsAbandoned).toBe(1);
      expect((await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } })).status).toBe(
        'FAILED',
      );
      expect(
        await prisma.auditLog.count({ where: { action: 'refund.abandoned', entityId: refund.id } }),
      ).toBe(1);
    });
  });

  // ═════════════════════════ Maintenance ═════════════════════════

  describe('maintenance des paiements', () => {
    it('rattrape un webhook PERDU : le prestataire a encaissé, la maintenance confirme la réservation', async () => {
      const v = await venue();
      const { booking, payment, providerRef } = await opened(v);
      payAtProviderSilently(providerRef);
      await prisma.payment.update({
        where: { id: payment.id },
        data: { createdAt: new Date(Date.now() - 5 * 60_000) },
      });

      const result = await paymentsMaintenance.runOnce();
      expect(result.synced).toBe(1);
      expect((await paymentOf(payment.id)).status).toBe('SUCCEEDED');
      expect((await bookingOf(booking.id)).status).toBe('CONFIRMED');
    });

    it('termine un traitement interrompu : paiement réussi mais réservation encore en attente', async () => {
      const v = await venue();
      const { booking, payment } = await opened(v);
      await prisma.payment.update({
        where: { id: payment.id },
        data: { status: 'SUCCEEDED', paidAt: new Date() },
      });

      const result = await paymentsMaintenance.runOnce();
      expect(result.resettled).toBeGreaterThanOrEqual(1);
      expect((await bookingOf(booking.id)).status).toBe('CONFIRMED');
    });

    it('ferme chez le prestataire les paiements ouverts d’une réservation expirée', async () => {
      const v = await venue();
      const { booking, payment, providerRef } = await opened(v);
      await prisma.booking.update({ where: { id: booking.id }, data: { status: 'EXPIRED' } });

      const result = await paymentsMaintenance.runOnce();
      expect(result.closedForDeadBookings).toBeGreaterThanOrEqual(1);
      expect((await paymentOf(payment.id)).status).toBe('CANCELLED');
      expect((await fake.getPaymentState(providerRef)).status).toBe('CANCELLED');
    });

    it('l’expiration d’un verrou ferme aussi le paiement ouvert (événement booking.expired)', async () => {
      const v = await venue();
      const { booking, payment, providerRef } = await opened(v);
      await prisma.booking.update({
        where: { id: booking.id },
        data: { holdExpiresAt: inMinutes(-1) },
      });
      await bookingsMaintenance.runOnce();

      expect((await bookingOf(booking.id)).status).toBe('EXPIRED');
      expect((await paymentOf(payment.id)).status).toBe('CANCELLED');
      expect((await fake.getPaymentState(providerRef)).status).toBe('CANCELLED');
    });

    it('fait échouer une initialisation abandonnée (plantage avant l’appel au prestataire)', async () => {
      const v = await venue();
      const { booking } = await pending(v);
      const stale = await prisma.payment.create({
        data: {
          bookingId: booking.id,
          provider: 'fake',
          kind: 'DEPOSIT',
          amountMinor: 800,
          status: 'INITIATED',
          idempotencyKey: randomUUID(),
          createdAt: new Date(Date.now() - 10 * 60_000),
        },
      });
      const result = await paymentsMaintenance.runOnce();
      expect(result.staleInitiated).toBe(1);
      expect(await paymentOf(stale.id)).toMatchObject({
        status: 'FAILED',
        failureReason: 'Initialisation abandonnée',
      });
    });

    it('est idempotent : une seconde exécution ne change plus rien', async () => {
      const v = await venue();
      const { providerRef, payment } = await opened(v);
      payAtProviderSilently(providerRef);
      await prisma.payment.update({
        where: { id: payment.id },
        data: { createdAt: new Date(Date.now() - 5 * 60_000) },
      });
      await paymentsMaintenance.runOnce();
      const again = await paymentsMaintenance.runOnce();
      expect(again).toMatchObject({
        synced: 0,
        resettled: 0,
        staleInitiated: 0,
        closedForDeadBookings: 0,
      });
    });
  });

  // ═════════════════════════ Consultation ═════════════════════════

  describe('GET /payments/:id', () => {
    it('ne montre que MES paiements (404 pour un tiers, 401 sans jeton, 400 si identifiant invalide)', async () => {
      const v = await venue();
      const { user, payment } = await opened(v);
      const stranger = await verifiedSignup(t);
      expect((await get(t, `/payments/${payment.id}`, user.accessToken)).statusCode).toBe(200);
      expect((await get(t, `/payments/${payment.id}`, stranger.accessToken)).statusCode).toBe(404);
      expect((await get(t, `/payments/${payment.id}`)).statusCode).toBe(401);
      expect((await get(t, '/payments/pas-un-uuid', user.accessToken)).statusCode).toBe(400);
    });

    it('ne donne plus l’adresse de paiement une fois le paiement terminé', async () => {
      const v = await venue();
      const { user, payment, providerRef } = await opened(v);
      await checkoutPost(providerRef, 'pay');
      const view = (await get(t, `/payments/${payment.id}`, user.accessToken)).json();
      expect(view).toMatchObject({ status: 'SUCCEEDED', checkoutUrl: null });
    });
  });
});
