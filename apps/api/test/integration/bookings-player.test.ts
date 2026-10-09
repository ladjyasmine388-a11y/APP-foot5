import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedBaseline } from '../../src/infra/database/baseline.js';
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
import { book, createVenueWithFields, dayIn, inMinutes, slotAt } from './venue-fixtures.js';

const DATE = dayIn(7);
const iso = (hhmm: string, date = DATE): string => slotAt(date, hhmm).toISOString();

describe('réservation côté joueur', () => {
  let t: TestApp;

  beforeAll(async () => {
    await resetDb();
    await seedBaseline(prisma); // commission globale 1 %, acompte 20 %, annulation 24 h
    t = await createTestApp();
  });
  afterAll(() => t.close());
  beforeEach(() => t.rateLimits.reset());

  // ───────────────────────── Outils ─────────────────────────

  const withKey = (user: Signup, key: string = randomUUID()) => ({
    ...bearer(user.accessToken),
    'idempotency-key': key,
  });
  const reserve = (
    user: Signup,
    fieldId: string,
    hhmm: string,
    extra: Record<string, unknown> = {},
    key?: string,
  ) => post(t, '/bookings', { fieldId, startsAt: iso(hhmm), ...extra }, withKey(user, key));
  const quote = (
    user: Signup,
    fieldId: string,
    hhmm: string,
    extra: Record<string, unknown> = {},
  ) =>
    post(
      t,
      '/bookings/quote',
      { fieldId, startsAt: iso(hhmm), ...extra },
      bearer(user.accessToken),
    );

  /** Complexe approuvé : 4 000 DA, 6 000 DA de 20:00 à 23:00, ouvert de 10:00 à 23:00. */
  async function venue(
    spec: Parameters<typeof createVenueWithFields>[0] = {},
    rules?: { priceMinor: number; priority?: number; startMin?: number; endMin?: number }[],
  ) {
    const { venue: v, fields } = await createVenueWithFields(spec, [
      {
        rules: rules ?? [
          { priceMinor: 4000 },
          { priceMinor: 6000, priority: 1, startMin: 1200, endMin: 1380 },
        ],
      },
    ]);
    return { venue: v, field: fields[0]! };
  }

  // ───────────────────────── Devis ─────────────────────────

  describe('POST /bookings/quote', () => {
    it('calcule prix et acompte côté serveur : 4 000 DA → acompte 20 % = 800 DA, 3 200 DA sur place', async () => {
      const { field } = await venue();
      const user = await verifiedSignup(t);
      const res = await quote(user, field.id, '12:00');

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        fieldId: field.id,
        startsAt: iso('12:00'),
        endsAt: iso('13:00'),
        paymentMode: 'DEPOSIT',
        priceMinor: 4000,
        feesMinor: 0,
        taxMinor: 0,
        totalMinor: 4000,
        dueOnlineMinor: 800,
        dueOnSiteMinor: 3200,
        currency: 'DZD',
        holdMinutes: 10,
      });
    });

    it('applique le tarif des heures de pointe (6 000 DA à 20:00 → acompte 1 200 DA)', async () => {
      const { field } = await venue();
      const user = await verifiedSignup(t);
      expect((await quote(user, field.id, '20:00')).json()).toMatchObject({
        priceMinor: 6000,
        dueOnlineMinor: 1200,
      });
    });

    it('paiement 100 % en ligne : tout est dû maintenant', async () => {
      const { field } = await venue();
      const user = await verifiedSignup(t);
      const res = await quote(user, field.id, '12:00', { paymentMode: 'FULL_ONLINE' });
      expect(res.json()).toMatchObject({ dueOnlineMinor: 4000, dueOnSiteMinor: 0 });
    });

    it('ne révèle PAS la commission de la plateforme au joueur', async () => {
      const { field } = await venue();
      const user = await verifiedSignup(t);
      const res = await quote(user, field.id, '12:00');
      expect(res.body).not.toMatch(/commission|platform|venueAmount/i);
    });

    it('l’acompte du COMPLEXE remplace celui de la plateforme', async () => {
      const { venue: v, field } = await venue();
      await prisma.venue.update({
        where: { id: v.id },
        data: { depositPolicy: { mode: 'FIXED', rateBps: 0, fixedMinor: 1500, minMinor: 0 } },
      });
      const user = await verifiedSignup(t);
      expect((await quote(user, field.id, '12:00')).json().dueOnlineMinor).toBe(1500);
    });

    it('l’acompte réglé par l’admin (paramètre plateforme) est pris en compte immédiatement', async () => {
      const { field } = await venue();
      const user = await verifiedSignup(t);
      await prisma.platformSetting.update({
        where: { key: 'booking.default_deposit' },
        data: { value: { mode: 'PERCENT', rateBps: 3000, fixedMinor: 0, minMinor: 0 } },
      });
      try {
        expect((await quote(user, field.id, '12:00')).json().dueOnlineMinor).toBe(1200);
      } finally {
        await seedBaseline(prisma);
        await prisma.platformSetting.update({
          where: { key: 'booking.default_deposit' },
          data: { value: { mode: 'PERCENT', rateBps: 2000, fixedMinor: 0, minMinor: 0 } },
        });
      }
    });

    it('l’acompte couvre TOUJOURS la commission de la plateforme (sinon elle ne serait pas encaissée)', async () => {
      const { venue: v, field } = await venue();
      const rule = await prisma.commissionRule.create({
        data: { scope: 'VENUE', venueId: v.id, rateBps: 5000 },
      }); // 50 %
      try {
        const user = await verifiedSignup(t);
        // 50 % de 4 000 = 2 000 DA de commission > acompte de 20 % (800 DA)
        expect((await quote(user, field.id, '12:00')).json().dueOnlineMinor).toBe(2000);
      } finally {
        await prisma.commissionRule.delete({ where: { id: rule.id } });
      }
    });

    it('exige un compte connecté ET un email vérifié', async () => {
      const { field } = await venue();
      expect(
        (await post(t, '/bookings/quote', { fieldId: field.id, startsAt: iso('12:00') }))
          .statusCode,
      ).toBe(401);
      const unverified = await signup(t);
      const res = await quote(unverified, field.id, '12:00');
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('EMAIL_NOT_VERIFIED');
    });

    describe('refuse un créneau non réservable', () => {
      it('terrain inconnu, inactif, ou complexe non approuvé → 404', async () => {
        const user = await verifiedSignup(t);
        expect((await quote(user, randomUUID(), '12:00')).statusCode).toBe(404);

        const inactive = await createVenueWithFields({}, [{ isActive: false }]);
        expect((await quote(user, inactive.fields[0]!.id, '12:00')).statusCode).toBe(404);

        const pending = await createVenueWithFields({ status: 'PENDING' }, [{}]);
        expect((await quote(user, pending.fields[0]!.id, '12:00')).statusCode).toBe(404);
        const suspended = await createVenueWithFields({ status: 'SUSPENDED' }, [{}]);
        expect((await quote(user, suspended.fields[0]!.id, '12:00')).statusCode).toBe(404);
      });

      it('créneau absent de la grille (20:30, hors horaires, durée incorrecte) → 422 SLOT_NOT_BOOKABLE', async () => {
        const { field } = await venue();
        const user = await verifiedSignup(t);
        for (const hhmm of ['12:30', '09:00', '23:00', '03:00']) {
          const res = await quote(user, field.id, hhmm);
          expect(res.statusCode, hhmm).toBe(422);
          expect(res.json().error.code).toBe('SLOT_NOT_BOOKABLE');
        }
      });

      it('créneau passé → 422 ; au-delà de l’horizon de réservation → 400', async () => {
        const { field } = await venue();
        const user = await verifiedSignup(t);
        const past = await post(
          t,
          '/bookings/quote',
          { fieldId: field.id, startsAt: iso('12:00', dayIn(-3)) },
          bearer(user.accessToken),
        );
        expect(past.statusCode).toBe(400);
        expect(past.json().error.details[0].code).toBe('date_in_past');

        const far = await post(
          t,
          '/bookings/quote',
          { fieldId: field.id, startsAt: iso('12:00', dayIn(90)) },
          bearer(user.accessToken),
        );
        expect(far.statusCode).toBe(400);
        expect(far.json().error.details[0].code).toBe('date_too_far');
      });

      it('créneau sans tarif → 422', async () => {
        const { field } = await venue({}, []);
        const user = await verifiedSignup(t);
        const res = await quote(user, field.id, '12:00');
        expect(res.statusCode).toBe(422);
        expect(res.json().error.code).toBe('SLOT_NOT_BOOKABLE');
      });

      it('créneau déjà réservé, bloqué ou en cours de paiement → 409 SLOT_UNAVAILABLE', async () => {
        const { venue: v, field } = await venue();
        const ids = { fieldId: field.id, venueId: v.id };
        await book(ids, DATE, '10:00');
        await book(ids, DATE, '11:00', { type: 'BLOCK' });
        await book(ids, DATE, '12:00', { status: 'PENDING_PAYMENT', holdExpiresAt: inMinutes(5) });
        const user = await verifiedSignup(t);
        for (const hhmm of ['10:00', '11:00', '12:00']) {
          const res = await quote(user, field.id, hhmm);
          expect(res.statusCode, hhmm).toBe(409);
          expect(res.json().error.code).toBe('SLOT_UNAVAILABLE');
        }
      });
    });

    describe('le client ne peut imposer aucun montant', () => {
      it.each([
        ['priceMinor', 1],
        ['totalMinor', 1],
        ['dueOnlineMinor', 0],
        ['commissionMinor', 0],
        ['commissionRateBps', 0],
        ['feesMinor', 0],
      ])(
        'refuse le champ « %s » (400) : aucun calcul financier n’est accepté du client',
        async (field, value) => {
          const { field: f } = await venue();
          const user = await verifiedSignup(t);
          const res = await quote(user, f.id, '12:00', { [field]: value });
          expect(res.statusCode).toBe(400);
          expect(res.json().error.code).toBe('VALIDATION_ERROR');
        },
      );

      it('refuse le paiement sur place pour un joueur (la commission ne serait pas encaissée) et les dates mal formées', async () => {
        const { field } = await venue();
        const user = await verifiedSignup(t);
        expect((await quote(user, field.id, '12:00', { paymentMode: 'ON_SITE' })).statusCode).toBe(
          400,
        );
        const bad = await post(
          t,
          '/bookings/quote',
          { fieldId: field.id, startsAt: 'demain 20h' },
          bearer(user.accessToken),
        );
        expect(bad.statusCode).toBe(400);
        const noZone = await post(
          t,
          '/bookings/quote',
          { fieldId: field.id, startsAt: '2026-10-27T12:00:00' },
          bearer(user.accessToken),
        );
        expect(noZone.statusCode).toBe(400);
      });
    });
  });

  // ───────────────────────── Création ─────────────────────────

  describe('POST /bookings', () => {
    it('crée la réservation en attente de paiement avec un verrou et le détail financier FIGÉ', async () => {
      const { venue: v, field } = await venue();
      const user = await verifiedSignup(t);
      const before = Date.now();
      const res = await reserve(user, field.id, '12:00');

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body).toMatchObject({
        status: 'PENDING_PAYMENT',
        reference: expect.stringMatching(/^FF-[2-9A-HJKMNP-Z]{8}$/),
        venue: { id: v.id, name: v.name },
        field: { id: field.id },
        startsAt: iso('12:00'),
        endsAt: iso('13:00'),
        paymentMode: 'DEPOSIT',
        priceMinor: 4000,
        totalMinor: 4000,
        dueOnlineMinor: 800,
        dueOnSiteMinor: 3200,
        paidOnlineMinor: 0,
        currency: 'DZD',
      });
      const holdMs = new Date(body.holdExpiresAt).getTime() - before;
      expect(holdMs).toBeGreaterThan(9 * 60_000);
      expect(holdMs).toBeLessThan(10 * 60_000 + 5000);

      // En base : snapshot complet, y compris la règle de commission appliquée.
      const row = await prisma.booking.findUniqueOrThrow({ where: { id: body.id } });
      const rule = await prisma.commissionRule.findFirstOrThrow({
        where: { scope: 'GLOBAL', isActive: true },
      });
      expect(row).toMatchObject({
        userId: user.userId,
        venueId: v.id,
        status: 'PENDING_PAYMENT',
        source: 'WEB',
        bookingType: 'STANDARD',
        basePriceMinor: 4000,
        commissionRuleId: rule.id,
        commissionRateBps: 100,
        commissionFixedMinor: 0,
        commissionMinor: 40,
        platformAmountMinor: 40,
        venueAmountMinor: 3960,
        totalMinor: 4000,
        dueOnlineMinor: 800,
        dueOnSiteMinor: 3200,
      });
    });

    it('ne divulgue pas les montants internes (commission, part du complexe, règle appliquée)', async () => {
      const { field } = await venue();
      const user = await verifiedSignup(t);
      const res = await reserve(user, field.id, '12:00');
      expect(res.body).not.toMatch(/commission|platformAmount|venueAmount/i);
    });

    it('un client mobile est enregistré comme tel', async () => {
      const { field } = await venue();
      const user = await verifiedSignup(t);
      const res = await post(
        t,
        '/bookings',
        { fieldId: field.id, startsAt: iso('12:00') },
        { ...withKey(user), 'x-client-platform': 'mobile' },
      );
      const row = await prisma.booking.findUniqueOrThrow({ where: { id: res.json().id } });
      expect(row.source).toBe('MOBILE');
    });

    it('paiement 100 % en ligne : tout est dû', async () => {
      const { field } = await venue();
      const user = await verifiedSignup(t);
      const res = await reserve(user, field.id, '12:00', { paymentMode: 'FULL_ONLINE' });
      expect(res.json()).toMatchObject({
        paymentMode: 'FULL_ONLINE',
        dueOnlineMinor: 4000,
        dueOnSiteMinor: 0,
      });
    });

    it('le créneau apparaît « en cours de paiement » (HELD) pour tout le monde', async () => {
      const { venue: v, field } = await venue();
      const user = await verifiedSignup(t);
      await reserve(user, field.id, '12:00');
      const day = (await get(t, `/venues/${v.slug}/availability?date=${DATE}`)).json();
      const slot = day.fields[0].slots.find(
        (s: { startsAt: string }) => s.startsAt === iso('12:00'),
      );
      expect(slot.status).toBe('HELD');
    });

    it('REFUSE les champs réservés au serveur (statut, verrou, utilisateur, montants)', async () => {
      const { field } = await venue();
      const user = await verifiedSignup(t);
      const victim = await verifiedSignup(t);
      for (const extra of [
        { status: 'CONFIRMED' },
        { holdExpiresAt: '2099-01-01T00:00:00.000Z' },
        { userId: victim.userId },
        { priceMinor: 1 },
        { source: 'ADMIN' },
        { bookingType: 'BLOCK' },
      ]) {
        const res = await reserve(user, field.id, '12:00', extra);
        expect(res.statusCode, JSON.stringify(extra)).toBe(400);
      }
      expect(await prisma.booking.count({ where: { fieldId: field.id } })).toBe(0);
    });

    it('exige un compte connecté et un email vérifié', async () => {
      const { field } = await venue();
      expect(
        (
          await post(
            t,
            '/bookings',
            { fieldId: field.id, startsAt: iso('12:00') },
            { 'idempotency-key': randomUUID() },
          )
        ).statusCode,
      ).toBe(401);
      const unverified = await signup(t);
      expect((await reserve(unverified, field.id, '12:00')).statusCode).toBe(403);
    });

    describe('Idempotency-Key', () => {
      it.each([
        ['absente', undefined],
        ['trop courte', 'abc'],
        ['caractères interdits', 'clé avec espace et é'],
      ])('est obligatoire et validée : %s → 400', async (_label, key) => {
        const { field } = await venue();
        const user = await verifiedSignup(t);
        const res = await post(
          t,
          '/bookings',
          { fieldId: field.id, startsAt: iso('12:00') },
          {
            ...bearer(user.accessToken),
            ...(key ? { 'idempotency-key': key } : {}),
          },
        );
        expect(res.statusCode).toBe(400);
        expect(res.json().error.details[0].path).toBe('Idempotency-Key');
        expect(await prisma.booking.count({ where: { fieldId: field.id } })).toBe(0);
      });

      it('rejouer la MÊME requête rend la MÊME réservation, sans en créer une seconde', async () => {
        const { field } = await venue();
        const user = await verifiedSignup(t);
        const key = randomUUID();
        const first = await reserve(user, field.id, '12:00', {}, key);
        const second = await reserve(user, field.id, '12:00', {}, key);

        expect(first.statusCode).toBe(201);
        expect(second.statusCode).toBe(201);
        expect(second.json()).toEqual(first.json());
        expect(first.headers['idempotent-replayed']).toBeUndefined();
        expect(second.headers['idempotent-replayed']).toBe('true');
        expect(await prisma.booking.count({ where: { fieldId: field.id } })).toBe(1);
      });

      it('la même clé avec un contenu DIFFÉRENT est refusée (422) et ne crée rien', async () => {
        const { field } = await venue();
        const user = await verifiedSignup(t);
        const key = randomUUID();
        await reserve(user, field.id, '12:00', {}, key);
        const other = await reserve(user, field.id, '14:00', {}, key);
        expect(other.statusCode).toBe(422);
        expect(other.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');
        expect(await prisma.booking.count({ where: { fieldId: field.id } })).toBe(1);
      });

      it('l’ordre des champs du JSON n’a pas d’importance', async () => {
        const { field } = await venue();
        const user = await verifiedSignup(t);
        const key = randomUUID();
        const a = await post(
          t,
          '/bookings',
          { fieldId: field.id, startsAt: iso('12:00'), paymentMode: 'DEPOSIT' },
          withKey(user, key),
        );
        const b = await post(
          t,
          '/bookings',
          { paymentMode: 'DEPOSIT', startsAt: iso('12:00'), fieldId: field.id },
          withKey(user, key),
        );
        expect(b.statusCode).toBe(201);
        expect(b.json().id).toBe(a.json().id);
      });

      it('deux utilisateurs peuvent utiliser la même clé sans interférer', async () => {
        const { field } = await venue();
        const [alice, bob] = await Promise.all([verifiedSignup(t), verifiedSignup(t)]);
        const key = randomUUID();
        const a = await reserve(alice, field.id, '12:00', {}, key);
        const b = await reserve(bob, field.id, '14:00', {}, key);
        expect(a.statusCode).toBe(201);
        expect(b.statusCode).toBe(201);
        expect(a.json().id).not.toBe(b.json().id);
      });

      it('5 requêtes IDENTIQUES simultanées créent UNE seule réservation', async () => {
        const { field } = await venue();
        const user = await verifiedSignup(t);
        const key = randomUUID();
        const results = await Promise.all(
          Array.from({ length: 5 }, () => reserve(user, field.id, '12:00', {}, key)),
        );

        expect(await prisma.booking.count({ where: { fieldId: field.id } })).toBe(1);
        const created = results.filter((r) => r.statusCode === 201);
        expect(created.length).toBeGreaterThanOrEqual(1);
        // Les autres : réponse rejouée (201) ou « requête en cours » (409), jamais une seconde réservation.
        for (const r of results) expect([201, 409]).toContain(r.statusCode);
        const ids = new Set(created.map((r) => r.json().id));
        expect(ids.size).toBe(1);
      });

      it('un échec libère la clé : après un refus, on peut réessayer avec la même clé', async () => {
        const { venue: v, field } = await venue();
        await book({ fieldId: field.id, venueId: v.id }, DATE, '12:00');
        const user = await verifiedSignup(t);
        const key = randomUUID();
        expect((await reserve(user, field.id, '12:00', {}, key)).statusCode).toBe(409);

        await prisma.booking.deleteMany({ where: { fieldId: field.id } }); // le créneau se libère
        expect((await reserve(user, field.id, '12:00', {}, key)).statusCode).toBe(201);
      });

      it('sans clé réutilisée, rejouer la même demande rend le même verrou (idempotence naturelle)', async () => {
        const { field } = await venue();
        const user = await verifiedSignup(t);
        const a = await reserve(user, field.id, '12:00');
        const b = await reserve(user, field.id, '12:00'); // autre clé, même créneau, même joueur
        expect(b.statusCode).toBe(201);
        expect(b.json().id).toBe(a.json().id);
        expect(await prisma.booking.count({ where: { fieldId: field.id } })).toBe(1);
      });
    });

    describe('CONCURRENCE : le cœur du produit', () => {
      it('2 joueurs réservent EN MÊME TEMPS le même terrain au même créneau : un seul obtient la réservation', async () => {
        const { field } = await venue();
        const [alice, bob] = await Promise.all([verifiedSignup(t), verifiedSignup(t)]);

        const [a, b] = await Promise.all([
          reserve(alice, field.id, '20:00'),
          reserve(bob, field.id, '20:00'),
        ]);

        expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
        const loser = a.statusCode === 409 ? a : b;
        expect(loser.json().error.code).toBe('SLOT_UNAVAILABLE');
        expect(await prisma.booking.count({ where: { fieldId: field.id } })).toBe(1);
      });

      it('20 joueurs simultanés sur le même créneau : EXACTEMENT un gagnant, 19 refus propres', async () => {
        const { field } = await venue();
        const players = await Promise.all(Array.from({ length: 20 }, () => verifiedSignup(t)));

        const results = await Promise.all(
          players.map((p) => reserve(p, field.id, '19:00', {}, undefined)),
        );

        const winners = results.filter((r) => r.statusCode === 201);
        const losers = results.filter((r) => r.statusCode !== 201);
        expect(winners).toHaveLength(1);
        expect(losers).toHaveLength(19);
        for (const r of losers) {
          expect(r.statusCode).toBe(409);
          expect(r.json().error.code).toBe('SLOT_UNAVAILABLE');
        }
        expect(await prisma.booking.count({ where: { fieldId: field.id } })).toBe(1);
      });

      it('des créneaux DIFFÉRENTS réservés en parallèle réussissent tous', async () => {
        const { field } = await venue();
        const players = await Promise.all(Array.from({ length: 6 }, () => verifiedSignup(t)));
        const slots = ['10:00', '11:00', '12:00', '13:00', '14:00', '15:00'];
        const results = await Promise.all(players.map((p, i) => reserve(p, field.id, slots[i]!)));
        expect(results.every((r) => r.statusCode === 201)).toBe(true);
        expect(await prisma.booking.count({ where: { fieldId: field.id } })).toBe(6);
      });

      it('un créneau libéré par une annulation peut être repris par un autre joueur', async () => {
        const { field } = await venue();
        const [alice, bob] = await Promise.all([verifiedSignup(t), verifiedSignup(t)]);
        const first = await reserve(alice, field.id, '20:00');
        expect((await reserve(bob, field.id, '20:00')).statusCode).toBe(409);

        await post(t, `/bookings/${first.json().id}/cancel`, {}, bearer(alice.accessToken));
        expect((await reserve(bob, field.id, '20:00')).statusCode).toBe(201);
      });
    });

    describe('expiration du verrou', () => {
      it('un verrou DÉPASSÉ libère le créneau tout de suite : un autre joueur peut réserver, l’ancien passe à EXPIRED', async () => {
        const { venue: v, field } = await venue();
        const [alice, bob] = await Promise.all([verifiedSignup(t), verifiedSignup(t)]);
        const stale = await reserve(alice, field.id, '20:00');
        // On simule 11 minutes d'attente : le verrou est dépassé mais personne n'a nettoyé la base.
        await prisma.booking.update({
          where: { id: stale.json().id },
          data: { holdExpiresAt: inMinutes(-1) },
        });

        const day = (await get(t, `/venues/${v.slug}/availability?date=${DATE}`)).json();
        expect(
          day.fields[0].slots.find((s: { startsAt: string }) => s.startsAt === iso('20:00')).status,
        ).toBe('AVAILABLE');

        const taken = await reserve(bob, field.id, '20:00');
        expect(taken.statusCode).toBe(201);
        expect(
          (await prisma.booking.findUniqueOrThrow({ where: { id: stale.json().id } })).status,
        ).toBe('EXPIRED');
      });

      it('la réservation expirée apparaît « EXPIRED » à son propriétaire, et ne peut plus être annulée', async () => {
        const { field } = await venue();
        const user = await verifiedSignup(t);
        const created = await reserve(user, field.id, '20:00');
        await prisma.booking.update({
          where: { id: created.json().id },
          data: { holdExpiresAt: inMinutes(-1) },
        });

        const view = (await get(t, `/bookings/${created.json().id}`, user.accessToken)).json();
        expect(view.status).toBe('EXPIRED');
        expect(view.holdExpiresAt).toBeNull();
        const cancel = await post(
          t,
          `/bookings/${created.json().id}/cancel`,
          {},
          bearer(user.accessToken),
        );
        expect(cancel.statusCode).toBe(409);
        expect(cancel.json().error.code).toBe('BOOKING_NOT_CANCELLABLE');
      });
    });

    describe('anti-accaparement', () => {
      it('un joueur ne peut pas bloquer plus de 3 créneaux en attente de paiement', async () => {
        const { field } = await venue();
        const user = await verifiedSignup(t);
        for (const h of ['10:00', '11:00', '12:00'])
          expect((await reserve(user, field.id, h)).statusCode).toBe(201);

        const fourth = await reserve(user, field.id, '13:00');
        expect(fourth.statusCode).toBe(409);
        expect(fourth.json().error.code).toBe('TOO_MANY_HOLDS');
        expect(await prisma.booking.count({ where: { userId: user.userId } })).toBe(3);
      });

      it('annuler ou laisser expirer un verrou libère de la place ; rejouer un verrou existant ne compte pas', async () => {
        const { field } = await venue();
        const user = await verifiedSignup(t);
        const ids: string[] = [];
        for (const h of ['10:00', '11:00', '12:00'])
          ids.push((await reserve(user, field.id, h)).json().id);

        // Rejouer l'un des trois ne déclenche pas la limite
        expect((await reserve(user, field.id, '10:00')).statusCode).toBe(201);

        await post(t, `/bookings/${ids[0]}/cancel`, {}, bearer(user.accessToken));
        expect((await reserve(user, field.id, '13:00')).statusCode).toBe(201);
      });

      it('la limite est réglable par l’admin (booking.max_active_holds)', async () => {
        const { field } = await venue();
        const user = await verifiedSignup(t);
        await prisma.platformSetting.update({
          where: { key: 'booking.max_active_holds' },
          data: { value: 1 },
        });
        try {
          expect((await reserve(user, field.id, '10:00')).statusCode).toBe(201);
          expect((await reserve(user, field.id, '11:00')).statusCode).toBe(409);
        } finally {
          await prisma.platformSetting.update({
            where: { key: 'booking.max_active_holds' },
            data: { value: 3 },
          });
        }
      });

      it('limite le débit : 20 tentatives par tranche de 10 minutes', async () => {
        const { field } = await venue();
        const user = await verifiedSignup(t);
        let limited = 0;
        for (let i = 0; i < 22; i++) {
          const res = await reserve(user, field.id, '10:00', {
            paymentMode: i % 2 === 0 ? 'DEPOSIT' : 'FULL_ONLINE',
          });
          if (res.statusCode === 429) limited++;
        }
        expect(limited).toBe(2);
      });
    });

    describe('commission', () => {
      it('une règle propre au complexe l’emporte sur la règle globale', async () => {
        const { venue: v, field } = await venue();
        const rule = await prisma.commissionRule.create({
          data: { scope: 'VENUE', venueId: v.id, rateBps: 50 },
        }); // 0,5 %
        try {
          const user = await verifiedSignup(t);
          const res = await reserve(user, field.id, '12:00');
          const row = await prisma.booking.findUniqueOrThrow({ where: { id: res.json().id } });
          expect(row).toMatchObject({
            commissionRuleId: rule.id,
            commissionRateBps: 50,
            commissionMinor: 20,
            venueAmountMinor: 3980,
          });
        } finally {
          await prisma.commissionRule.delete({ where: { id: rule.id } });
        }
      });

      it('une règle par type de réservation s’applique, mais moins prioritaire que celle du complexe', async () => {
        const { venue: v, field } = await venue();
        const typeRule = await prisma.commissionRule.create({
          data: { scope: 'BOOKING_TYPE', bookingType: 'STANDARD', rateBps: 200 },
        });
        try {
          const user = await verifiedSignup(t);
          const a = await reserve(user, field.id, '12:00');
          expect(
            (await prisma.booking.findUniqueOrThrow({ where: { id: a.json().id } }))
              .commissionMinor,
          ).toBe(80); // 2 %

          const venueRule = await prisma.commissionRule.create({
            data: { scope: 'VENUE', venueId: v.id, rateBps: 300 },
          });
          const b = await reserve(user, field.id, '13:00');
          expect(
            (await prisma.booking.findUniqueOrThrow({ where: { id: b.json().id } }))
              .commissionMinor,
          ).toBe(120); // 3 % l'emporte
          await prisma.commissionRule.delete({ where: { id: venueRule.id } });
        } finally {
          await prisma.commissionRule.delete({ where: { id: typeRule.id } });
        }
      });

      it('modifier la commission plus tard ne change PAS les réservations existantes (instantané figé)', async () => {
        const { field } = await venue();
        const user = await verifiedSignup(t);
        const before = await reserve(user, field.id, '12:00');

        const global = await prisma.commissionRule.findFirstOrThrow({
          where: { scope: 'GLOBAL', isActive: true },
        });
        await prisma.commissionRule.update({ where: { id: global.id }, data: { rateBps: 500 } });
        try {
          const after = await reserve(user, field.id, '13:00');
          const rows = await prisma.booking.findMany({
            where: { id: { in: [before.json().id, after.json().id] } },
          });
          const byId = new Map(rows.map((r) => [r.id, r]));
          expect(byId.get(before.json().id)?.commissionMinor).toBe(40); // 1 %, figé
          expect(byId.get(after.json().id)?.commissionMinor).toBe(200); // 5 %
        } finally {
          await prisma.commissionRule.update({ where: { id: global.id }, data: { rateBps: 100 } });
        }
      });

      it('sans AUCUNE règle de commission active : refus (503) plutôt que vente sans commission', async () => {
        const { field } = await venue();
        const user = await verifiedSignup(t);
        const global = await prisma.commissionRule.findFirstOrThrow({
          where: { scope: 'GLOBAL', isActive: true },
        });
        await prisma.commissionRule.update({ where: { id: global.id }, data: { isActive: false } });
        try {
          const res = await reserve(user, field.id, '12:00');
          expect(res.statusCode).toBe(503);
          expect(await prisma.booking.count({ where: { fieldId: field.id } })).toBe(0);
        } finally {
          await prisma.commissionRule.update({
            where: { id: global.id },
            data: { isActive: true },
          });
        }
      });
    });
  });

  // ───────────────────────── Consultation ─────────────────────────

  describe('mes réservations', () => {
    it('liste « à venir » : verrous valides et réservations confirmées ; les verrous expirés vont dans « passées »', async () => {
      const { venue: v, field } = await venue();
      const ids = { fieldId: field.id, venueId: v.id };
      const user = await verifiedSignup(t);
      const pending = await reserve(user, field.id, '10:00');
      const confirmed = await book(ids, DATE, '11:00', { userId: user.userId });
      const stale = await reserve(user, field.id, '12:00');
      await prisma.booking.update({
        where: { id: stale.json().id },
        data: { holdExpiresAt: inMinutes(-1) },
      });
      await book(ids, dayIn(-5), '12:00', { userId: user.userId, status: 'COMPLETED' });

      const upcoming = (await get(t, '/bookings?when=upcoming', user.accessToken)).json();
      expect(upcoming.items.map((b: { id: string }) => b.id)).toEqual([
        pending.json().id,
        confirmed.id,
      ]);

      const past = (await get(t, '/bookings?when=past', user.accessToken)).json();
      expect(past.items.map((b: { status: string }) => b.status).sort()).toEqual([
        'COMPLETED',
        'EXPIRED',
      ]);

      const all = (await get(t, '/bookings?when=all', user.accessToken)).json();
      expect(all.items).toHaveLength(4);
    });

    it('filtre par statut et pagine sans perdre ni dupliquer de résultat', async () => {
      const { venue: v, field } = await venue();
      const user = await verifiedSignup(t);
      for (const h of ['10:00', '11:00', '12:00', '13:00', '14:00']) {
        await book({ fieldId: field.id, venueId: v.id }, DATE, h, { userId: user.userId });
      }
      await book({ fieldId: field.id, venueId: v.id }, DATE, '15:00', {
        userId: user.userId,
        status: 'CANCELLED',
      });

      const confirmedOnly = (
        await get(t, '/bookings?when=all&status=CONFIRMED', user.accessToken)
      ).json();
      expect(confirmedOnly.items).toHaveLength(5);

      const page1 = (await get(t, '/bookings?when=upcoming&limit=2', user.accessToken)).json();
      expect(page1.items).toHaveLength(2);
      expect(page1.nextCursor).toEqual(expect.any(String));
      const page2 = (
        await get(t, `/bookings?when=upcoming&limit=2&cursor=${page1.nextCursor}`, user.accessToken)
      ).json();
      const page3 = (
        await get(t, `/bookings?when=upcoming&limit=2&cursor=${page2.nextCursor}`, user.accessToken)
      ).json();
      const all = [...page1.items, ...page2.items, ...page3.items].map(
        (b: { startsAt: string }) => b.startsAt,
      );
      expect(all).toEqual([iso('10:00'), iso('11:00'), iso('12:00'), iso('13:00'), iso('14:00')]);
      expect(page3.nextCursor).toBeNull();
      expect((await get(t, '/bookings?cursor=nimporte-quoi', user.accessToken)).statusCode).toBe(
        400,
      );
    });

    it('ne montre QUE mes réservations ; une réservation d’autrui donne 404 (pas d’IDOR) ; les blocages ne sont jamais visibles', async () => {
      const { venue: v, field } = await venue();
      const ids = { fieldId: field.id, venueId: v.id };
      const [alice, bob] = await Promise.all([verifiedSignup(t), verifiedSignup(t)]);
      const aliceBooking = await book(ids, DATE, '10:00', { userId: alice.userId });
      const block = await book(ids, DATE, '11:00', { type: 'BLOCK' });

      expect((await get(t, '/bookings?when=all', bob.accessToken)).json().items).toEqual([]);
      expect((await get(t, `/bookings/${aliceBooking.id}`, bob.accessToken)).statusCode).toBe(404);
      expect((await get(t, `/bookings/${block.id}`, alice.accessToken)).statusCode).toBe(404);
      expect((await get(t, `/bookings/${aliceBooking.id}`, alice.accessToken)).statusCode).toBe(
        200,
      );
      expect((await get(t, '/bookings/pas-un-uuid', alice.accessToken)).statusCode).toBe(400);
      expect((await get(t, '/bookings')).statusCode).toBe(401);
    });

    it('indique le montant déjà PAYÉ (uniquement les paiements confirmés par le serveur) et la politique d’annulation', async () => {
      const { venue: v, field } = await venue();
      const user = await verifiedSignup(t);
      const booking = await book({ fieldId: field.id, venueId: v.id }, DATE, '12:00', {
        userId: user.userId,
      });
      await prisma.payment.createMany({
        data: [
          {
            bookingId: booking.id,
            provider: 'fake',
            kind: 'DEPOSIT',
            amountMinor: 800,
            status: 'SUCCEEDED',
            idempotencyKey: randomUUID(),
          },
          {
            bookingId: booking.id,
            provider: 'fake',
            kind: 'BALANCE',
            amountMinor: 3200,
            status: 'PENDING',
            idempotencyKey: randomUUID(),
          },
          {
            bookingId: booking.id,
            provider: 'fake',
            kind: 'FULL',
            amountMinor: 4000,
            status: 'FAILED',
            idempotencyKey: randomUUID(),
          },
        ],
      });
      const view = (await get(t, `/bookings/${booking.id}`, user.accessToken)).json();
      expect(view.paidOnlineMinor).toBe(800); // ni le paiement en attente, ni l'échec
      expect(view.cancellation).toMatchObject({ allowed: true, refundable: true });
      expect(new Date(view.cancellation.freeUntil).getTime()).toBe(
        slotAt(DATE, '12:00').getTime() - 24 * 3600_000,
      );
    });
  });

  // ───────────────────────── Annulation ─────────────────────────

  describe('POST /bookings/:id/cancel', () => {
    async function paidBooking(hhmm: string, date = DATE) {
      const { venue: v, field } = await venue();
      const user = await verifiedSignup(t);
      const booking = await book({ fieldId: field.id, venueId: v.id }, date, hhmm, {
        userId: user.userId,
      });
      const payment = await prisma.payment.create({
        data: {
          bookingId: booking.id,
          provider: 'fake',
          kind: 'DEPOSIT',
          amountMinor: 800,
          status: 'SUCCEEDED',
          idempotencyKey: randomUUID(),
        },
      });
      return { venue: v, field, user, booking, payment };
    }
    const cancel = (user: Signup, id: string, body: object = {}) =>
      post(t, `/bookings/${id}/cancel`, body, bearer(user.accessToken));

    it('une réservation en attente de paiement s’annule librement et libère le créneau', async () => {
      const { venue: v, field } = await venue();
      const user = await verifiedSignup(t);
      const created = await reserve(user, field.id, '12:00');

      const res = await cancel(user, created.json().id, { reason: 'Changement de plan' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        booking: {
          status: 'CANCELLED',
          cancellationReason: 'Changement de plan',
          holdExpiresAt: null,
        },
        refund: { eligible: false, amountMinor: 0 },
      });
      const day = (await get(t, `/venues/${v.slug}/availability?date=${DATE}`)).json();
      expect(
        day.fields[0].slots.find((s: { startsAt: string }) => s.startsAt === iso('12:00')).status,
      ).toBe('AVAILABLE');
    });

    it('annulation GRATUITE (≥ 24 h avant) : une demande de remboursement intégral est créée', async () => {
      const { user, booking, payment } = await paidBooking('12:00', dayIn(7));
      const res = await cancel(user, booking.id);

      expect(res.statusCode).toBe(200);
      expect(res.json().refund).toEqual({ eligible: true, amountMinor: 800 });
      expect(res.json().booking.status).toBe('CANCELLED');

      const refunds = await prisma.refund.findMany({ where: { bookingId: booking.id } });
      expect(refunds).toHaveLength(1);
      expect(refunds[0]).toMatchObject({
        paymentId: payment.id,
        amountMinor: 800,
        status: 'REQUESTED',
        requestedById: user.userId,
      });
    });

    it('annulation TARDIVE (< 24 h avant) : l’acompte reste acquis, aucun remboursement', async () => {
      const { venue: v, field } = await venue({}, [{ priceMinor: 4000 }]);
      const user = await verifiedSignup(t);
      // Un créneau dans quelques heures (aujourd'hui ou demain selon l'heure) : on fabrique la réservation directement.
      const start = new Date(Date.now() + 5 * 3600_000);
      start.setMinutes(0, 0, 0);
      const booking = await prisma.booking.create({
        data: {
          ...bookingData({ fieldId: field.id, venueId: v.id }, { userId: user.userId, start }),
        },
      });
      await prisma.payment.create({
        data: {
          bookingId: booking.id,
          provider: 'fake',
          kind: 'DEPOSIT',
          amountMinor: 800,
          status: 'SUCCEEDED',
          idempotencyKey: randomUUID(),
        },
      });

      const res = await cancel(user, booking.id);
      expect(res.statusCode).toBe(200);
      expect(res.json().refund).toEqual({ eligible: false, amountMinor: 0 });
      expect(res.json().booking.status).toBe('CANCELLED'); // le créneau est quand même libéré
      expect(await prisma.refund.count({ where: { bookingId: booking.id } })).toBe(0);
    });

    it('le complexe peut choisir de rembourser l’acompte même tardivement (refundDeposit)', async () => {
      const { venue: v, field } = await venue({}, [{ priceMinor: 4000 }]);
      await prisma.venue.update({
        where: { id: v.id },
        data: { cancellationPolicy: { freeUntilHoursBefore: 24, refundDeposit: true } },
      });
      const user = await verifiedSignup(t);
      const start = new Date(Date.now() + 5 * 3600_000);
      start.setMinutes(0, 0, 0);
      const booking = await prisma.booking.create({
        data: {
          ...bookingData({ fieldId: field.id, venueId: v.id }, { userId: user.userId, start }),
        },
      });
      await prisma.payment.create({
        data: {
          bookingId: booking.id,
          provider: 'fake',
          kind: 'DEPOSIT',
          amountMinor: 800,
          status: 'SUCCEEDED',
          idempotencyKey: randomUUID(),
        },
      });
      expect((await cancel(user, booking.id)).json().refund).toEqual({
        eligible: true,
        amountMinor: 800,
      });
    });

    it('un paiement déjà remboursé ou en cours de remboursement n’est pas remboursé deux fois', async () => {
      const { user, booking, payment } = await paidBooking('12:00', dayIn(7));
      await prisma.refund.create({
        data: {
          paymentId: payment.id,
          bookingId: booking.id,
          amountMinor: 800,
          status: 'PROCESSING',
        },
      });
      await cancel(user, booking.id);
      expect(await prisma.refund.count({ where: { bookingId: booking.id } })).toBe(1);
    });

    it('journalise l’annulation (audit)', async () => {
      const { user, booking } = await paidBooking('12:00', dayIn(7));
      await cancel(user, booking.id);
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { action: 'booking.cancel', entityId: booking.id },
      });
      expect(audit.actorId).toBe(user.userId);
      expect(audit.after).toMatchObject({
        status: 'CANCELLED',
        refundEligible: true,
        refundMinor: 800,
      });
    });

    it('refuse : déjà annulée, déjà commencée, terminée (409)', async () => {
      const { venue: v, field } = await venue();
      const user = await verifiedSignup(t);
      const ids = { fieldId: field.id, venueId: v.id };
      const cancelled = await book(ids, DATE, '10:00', {
        userId: user.userId,
        status: 'CANCELLED',
      });
      const completed = await book(ids, dayIn(-3), '10:00', {
        userId: user.userId,
        status: 'COMPLETED',
      });
      const started = await prisma.booking.create({
        data: bookingData(ids, { userId: user.userId, start: new Date(Date.now() - 30 * 60_000) }),
      });

      for (const b of [cancelled, completed, started]) {
        const res = await cancel(user, b.id);
        expect(res.statusCode, b.id).toBe(409);
        expect(res.json().error.code).toBe('BOOKING_NOT_CANCELLABLE');
      }
    });

    it('annuler deux fois : la seconde est refusée et n’émet pas un second remboursement', async () => {
      const { user, booking } = await paidBooking('12:00', dayIn(7));
      expect((await cancel(user, booking.id)).statusCode).toBe(200);
      expect((await cancel(user, booking.id)).statusCode).toBe(409);
      expect(await prisma.refund.count({ where: { bookingId: booking.id } })).toBe(1);
    });

    it('5 annulations SIMULTANÉES de la même réservation : une seule réussit, un seul remboursement', async () => {
      const { user, booking } = await paidBooking('12:00', dayIn(7));
      const results = await Promise.all(Array.from({ length: 5 }, () => cancel(user, booking.id)));
      expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
      expect(results.filter((r) => r.statusCode === 409)).toHaveLength(4);
      expect(await prisma.refund.count({ where: { bookingId: booking.id } })).toBe(1);
    });

    it('on ne peut annuler que SES réservations (404 sinon) ; jamais un blocage', async () => {
      const { user, booking } = await paidBooking('12:00', dayIn(7));
      const stranger = await verifiedSignup(t);
      expect((await cancel(stranger, booking.id)).statusCode).toBe(404);
      expect((await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe(
        'CONFIRMED',
      );

      const { venue: v, field } = await venue();
      const block = await book({ fieldId: field.id, venueId: v.id }, DATE, '10:00', {
        type: 'BLOCK',
      });
      expect((await cancel(user, block.id)).statusCode).toBe(404);
    });

    it('refuse une raison trop longue et les champs inconnus', async () => {
      const { user, booking } = await paidBooking('12:00', dayIn(7));
      expect((await cancel(user, booking.id, { reason: 'x'.repeat(400) })).statusCode).toBe(400);
      expect((await cancel(user, booking.id, { refund: 9999 })).statusCode).toBe(400);
      expect((await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe(
        'CONFIRMED',
      );
    });
  });
});
