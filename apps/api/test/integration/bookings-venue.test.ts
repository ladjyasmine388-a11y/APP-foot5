import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedBaseline } from '../../src/infra/database/baseline.js';
import { NO_SHOW_PENALTY } from '../../src/modules/bookings/venue-bookings.service.js';
import {
  type Signup,
  type TestApp,
  bearer,
  createTestApp,
  del,
  get,
  post,
  signup,
  verifiedSignup,
} from './app-helper.js';
import { bookingData, prisma, resetDb } from './helpers.js';
import { book, createVenueWithFields, dayIn, inMinutes, slotAt } from './venue-fixtures.js';

const DATE = dayIn(7);
const iso = (hhmm: string, date = DATE): string => slotAt(date, hhmm).toISOString();

describe('réservations vues par le complexe', () => {
  let t: TestApp;

  beforeAll(async () => {
    await resetDb();
    await seedBaseline(prisma);
    t = await createTestApp();
  });
  afterAll(() => t.close());
  beforeEach(() => t.rateLimits.reset());

  // ───────────────────────── Outils ─────────────────────────

  /** Complexe (4 000 DA, 10:00–23:00) avec un membre de chaque rôle et un étranger. */
  async function setup(hours?: { from: number; to: number }, rules?: { priceMinor: number }[]) {
    const { venue, fields } = await createVenueWithFields({ hours }, [{ rules }]);
    const [owner, manager, staff, outsider] = await Promise.all([
      signup(t),
      signup(t),
      signup(t),
      signup(t),
    ]);
    await prisma.venueStaff.createMany({
      data: [
        { venueId: venue.id, userId: owner.userId, role: 'OWNER' },
        { venueId: venue.id, userId: manager.userId, role: 'MANAGER' },
        { venueId: venue.id, userId: staff.userId, role: 'STAFF' },
      ],
    });
    return {
      venue,
      field: fields[0]!,
      ids: { fieldId: fields[0]!.id, venueId: venue.id },
      owner,
      manager,
      staff,
      outsider,
    };
  }
  type Setup = Awaited<ReturnType<typeof setup>>;

  const base = (s: Setup) => `/manage/venues/${s.venue.id}`;
  const manual = (
    s: Setup,
    user: Signup,
    hhmm: string,
    extra: Record<string, unknown> = {},
    date = DATE,
  ) =>
    post(
      t,
      `${base(s)}/bookings`,
      { fieldId: s.field.id, startsAt: iso(hhmm, date), customerName: 'Karim Benali', ...extra },
      bearer(user.accessToken),
    );
  const block = (
    s: Setup,
    user: Signup,
    from: string,
    to: string,
    extra: Record<string, unknown> = {},
    date = DATE,
  ) =>
    post(
      t,
      `${base(s)}/blocks`,
      { fieldId: s.field.id, startsAt: iso(from, date), endsAt: iso(to, date), ...extra },
      bearer(user.accessToken),
    );
  const publicStatus = async (s: Setup, hhmm: string, date = DATE): Promise<string | undefined> => {
    const day = (await get(t, `/venues/${s.venue.slug}/availability?date=${date}`)).json();
    return day.fields[0].slots.find((x: { startsAt: string }) => x.startsAt === iso(hhmm, date))
      ?.status;
  };

  // ───────────────────────── Calendrier ─────────────────────────

  describe('GET /manage/venues/:id/bookings', () => {
    it('liste réservations de joueurs, saisies manuelles et blocages avec le contact du client', async () => {
      const s = await setup();
      const player = await verifiedSignup(t, {
        firstName: 'Yasmine',
        lastName: 'Benali',
        phone: '0550 11 22 33',
      });
      await book(s.ids, DATE, '10:00', { userId: player.userId });
      await manual(s, s.staff, '11:00', { customerPhone: '0661 00 00 00', note: 'Anniversaire' });
      await block(s, s.manager, '12:00', '14:00', { reason: 'Pelouse' });

      const res = await get(t, `${base(s)}/bookings?from=${DATE}&to=${DATE}`, s.staff.accessToken);
      expect(res.statusCode).toBe(200);
      const list = res.json();
      expect(list).toHaveLength(3);
      expect(list[0]).toMatchObject({
        startsAt: iso('10:00'),
        bookingType: 'STANDARD',
        customer: { name: 'Yasmine Benali', phone: '+213550112233' },
        status: 'CONFIRMED',
      });
      expect(list[1]).toMatchObject({
        source: 'VENUE_MANUAL',
        customer: { name: 'Karim Benali', phone: '+213661000000' },
        note: 'Anniversaire',
        paymentMode: 'ON_SITE',
      });
      expect(list[2]).toMatchObject({ bookingType: 'BLOCK', customer: null, note: 'Pelouse' });
    });

    it('montre au complexe sa commission et sa part nette', async () => {
      const s = await setup();
      const player = await verifiedSignup(t);
      await book(s.ids, DATE, '10:00', { userId: player.userId });
      const [row] = (
        await get(t, `${base(s)}/bookings?from=${DATE}&to=${DATE}`, s.staff.accessToken)
      ).json();
      expect(row).toMatchObject({ priceMinor: 4000, commissionMinor: 40, venueAmountMinor: 3960 });
    });

    it('filtre : sans blocages, par statut, par terrain', async () => {
      const s = await setup();
      const second = await prisma.field.create({
        data: { venueId: s.venue.id, name: 'Terrain 2' },
      });
      await book(s.ids, DATE, '10:00');
      await book(s.ids, DATE, '11:00', { type: 'BLOCK' });
      await book(s.ids, DATE, '12:00', { status: 'CANCELLED' });
      await book({ fieldId: second.id, venueId: s.venue.id }, DATE, '10:00');
      const q = (extra: string) =>
        get(t, `${base(s)}/bookings?from=${DATE}&to=${DATE}${extra}`, s.staff.accessToken).then(
          (r) => r.json(),
        );

      expect(await q('')).toHaveLength(4);
      expect(await q('&includeBlocks=false')).toHaveLength(3);
      expect(await q('&status=CANCELLED')).toHaveLength(1);
      expect(await q(`&fieldId=${second.id}`)).toHaveLength(1);
    });

    it('un verrou de paiement expiré apparaît comme « EXPIRED »', async () => {
      const s = await setup();
      await book(s.ids, DATE, '10:00', { status: 'PENDING_PAYMENT', holdExpiresAt: inMinutes(-5) });
      const [row] = (
        await get(t, `${base(s)}/bookings?from=${DATE}&to=${DATE}`, s.staff.accessToken)
      ).json();
      expect(row.status).toBe('EXPIRED');
    });

    it('inclut les créneaux d’après minuit rattachés au dernier jour demandé', async () => {
      const s = await setup({ from: 22 * 60, to: 26 * 60 });
      const night = await prisma.booking.create({
        data: bookingData(s.ids, { start: slotAt(dayIn(8), '00:00') }), // 00:00 le lendemain = jour de service DATE
      });
      const list = (
        await get(t, `${base(s)}/bookings?from=${DATE}&to=${DATE}`, s.staff.accessToken)
      ).json();
      expect(list.map((b: { id: string }) => b.id)).toContain(night.id);
    });

    it('ne montre JAMAIS les réservations d’un autre complexe', async () => {
      const s = await setup();
      const other = await setup();
      await book(other.ids, DATE, '10:00');
      expect(
        (await get(t, `${base(s)}/bookings?from=${DATE}&to=${DATE}`, s.staff.accessToken)).json(),
      ).toEqual([]);
    });

    it('valide la période (≤ 62 jours, fin ≥ début) et exige l’appartenance au complexe', async () => {
      const s = await setup();
      expect(
        (await get(t, `${base(s)}/bookings?from=${DATE}&to=${dayIn(90)}`, s.staff.accessToken))
          .statusCode,
      ).toBe(400);
      expect(
        (await get(t, `${base(s)}/bookings?from=${DATE}&to=${dayIn(3)}`, s.staff.accessToken))
          .statusCode,
      ).toBe(400);
      expect((await get(t, `${base(s)}/bookings`, s.staff.accessToken)).statusCode).toBe(400);
      expect(
        (await get(t, `${base(s)}/bookings?from=${DATE}&to=${DATE}`, s.outsider.accessToken))
          .statusCode,
      ).toBe(404);
      expect((await get(t, `${base(s)}/bookings?from=${DATE}&to=${DATE}`)).statusCode).toBe(401);
    });
  });

  // ───────────────────────── Réservation manuelle ─────────────────────────

  describe('POST /manage/venues/:id/bookings (saisie manuelle)', () => {
    it('le STAFF saisit une réservation : confirmée, SANS commission, tout se règle sur place', async () => {
      const s = await setup();
      const res = await manual(s, s.staff, '12:00', { customerPhone: '0550 12 34 56' });

      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({
        status: 'CONFIRMED',
        source: 'VENUE_MANUAL',
        bookingType: 'STANDARD',
        paymentMode: 'ON_SITE',
        priceMinor: 4000,
        totalMinor: 4000,
        commissionMinor: 0,
        venueAmountMinor: 4000,
        dueOnlineMinor: 0,
        dueOnSiteMinor: 4000,
        customer: { name: 'Karim Benali', phone: '+213550123456' },
      });
      const row = await prisma.booking.findUniqueOrThrow({ where: { id: res.json().id } });
      expect(row).toMatchObject({
        userId: null,
        createdById: s.staff.userId,
        commissionRateBps: 0,
        platformAmountMinor: 0,
      });
      expect(await publicStatus(s, '12:00')).toBe('UNAVAILABLE');
    });

    it('accepte un prix convenu différent du tarif (y compris gratuit)', async () => {
      const s = await setup();
      expect((await manual(s, s.staff, '12:00', { priceMinor: 3000 })).json()).toMatchObject({
        priceMinor: 3000,
        venueAmountMinor: 3000,
      });
      expect((await manual(s, s.staff, '13:00', { priceMinor: 0 })).json()).toMatchObject({
        priceMinor: 0,
        totalMinor: 0,
      });
    });

    it('un créneau sans tarif exige un prix convenu', async () => {
      const s = await setup(undefined, []);
      const missing = await manual(s, s.staff, '12:00');
      expect(missing.statusCode).toBe(400);
      expect(missing.json().error.details[0].path).toBe('priceMinor');
      expect((await manual(s, s.staff, '12:00', { priceMinor: 3500 })).statusCode).toBe(201);
    });

    it('refuse un créneau déjà pris (réservé, bloqué, en cours de paiement) : 409', async () => {
      const s = await setup();
      await book(s.ids, DATE, '10:00');
      await book(s.ids, DATE, '11:00', { type: 'BLOCK' });
      await book(s.ids, DATE, '12:00', { status: 'PENDING_PAYMENT', holdExpiresAt: inMinutes(5) });
      for (const hhmm of ['10:00', '11:00', '12:00']) {
        const res = await manual(s, s.staff, hhmm);
        expect(res.statusCode, hhmm).toBe(409);
        expect(res.json().error.code).toBe('SLOT_UNAVAILABLE');
      }
    });

    it('un créneau dont le verrou de paiement est expiré peut être saisi', async () => {
      const s = await setup();
      const stale = await book(s.ids, DATE, '10:00', {
        status: 'PENDING_PAYMENT',
        holdExpiresAt: inMinutes(-1),
      });
      expect((await manual(s, s.staff, '10:00')).statusCode).toBe(201);
      expect((await prisma.booking.findUniqueOrThrow({ where: { id: stale.id } })).status).toBe(
        'EXPIRED',
      );
    });

    it('deux membres du personnel saisissent le même créneau EN MÊME TEMPS : un seul réussit', async () => {
      const s = await setup();
      const results = await Promise.all([
        manual(s, s.staff, '15:00'),
        manual(s, s.manager, '15:00'),
        manual(s, s.owner, '15:00'),
      ]);
      expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
      expect(results.filter((r) => r.statusCode === 409)).toHaveLength(2);
      expect(await prisma.booking.count({ where: { fieldId: s.field.id } })).toBe(1);
    });

    it('un joueur et le complexe visent le même créneau EN MÊME TEMPS : un seul réussit', async () => {
      const s = await setup();
      const player = await verifiedSignup(t);
      const [a, b] = await Promise.all([
        manual(s, s.staff, '16:00'),
        post(
          t,
          '/bookings',
          { fieldId: s.field.id, startsAt: iso('16:00') },
          { ...bearer(player.accessToken), 'idempotency-key': randomUUID() },
        ),
      ]);
      expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
      expect(await prisma.booking.count({ where: { fieldId: s.field.id } })).toBe(1);
    });

    it('un client qui se présente : le créneau EN COURS reste réservable, un créneau terminé non', async () => {
      const s = await setup({ from: 0, to: 24 * 60 });
      const hourStart = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000); // le créneau d'une heure en cours
      const inProgress = await post(
        t,
        `${base(s)}/bookings`,
        {
          fieldId: s.field.id,
          startsAt: hourStart.toISOString(),
          customerName: 'Client de passage',
        },
        bearer(s.staff.accessToken),
      );
      expect(inProgress.statusCode).toBe(201);

      const finished = new Date(hourStart.getTime() - 2 * 3_600_000);
      const past = await post(
        t,
        `${base(s)}/bookings`,
        { fieldId: s.field.id, startsAt: finished.toISOString(), customerName: 'Trop tard' },
        bearer(s.staff.accessToken),
      );
      expect(past.statusCode).toBe(422);
      expect(past.json().error.code).toBe('SLOT_NOT_BOOKABLE');
    });

    it('refuse un horaire hors grille (422) et le terrain d’un AUTRE complexe (404)', async () => {
      const s = await setup();
      const other = await setup();
      expect((await manual(s, s.staff, '12:30')).statusCode).toBe(422);
      const res = await post(
        t,
        `${base(s)}/bookings`,
        { fieldId: other.field.id, startsAt: iso('12:00'), customerName: 'X' },
        bearer(s.staff.accessToken),
      );
      expect(res.statusCode).toBe(404);
      expect(await prisma.booking.count({ where: { fieldId: other.field.id } })).toBe(0);
    });

    it('un non-membre reçoit 404 ; un administrateur de la plateforme est autorisé ; l’action est auditée', async () => {
      const s = await setup();
      expect((await manual(s, s.outsider, '12:00')).statusCode).toBe(404);

      const admin = await signup(t);
      await prisma.user.update({ where: { id: admin.userId }, data: { platformRole: 'ADMIN' } });
      const res = await manual(s, admin, '12:00');
      expect(res.statusCode).toBe(201);
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { action: 'booking.manual_create', entityId: res.json().id },
      });
      expect(audit).toMatchObject({ actorId: admin.userId, actorRole: 'ADMIN' });
    });

    it('REFUSE les champs réservés au serveur (statut, client, montants) et valide les données', async () => {
      const s = await setup();
      for (const extra of [
        { status: 'CONFIRMED' },
        { userId: s.owner.userId },
        { commissionMinor: 5000 },
        { paymentMode: 'FULL_ONLINE' },
        { customerName: '' },
        { customerPhone: 'abc' },
        { priceMinor: -1 },
        { priceMinor: 1_000_000 },
      ]) {
        expect((await manual(s, s.staff, '12:00', extra)).statusCode, JSON.stringify(extra)).toBe(
          400,
        );
      }
      expect(await prisma.booking.count({ where: { fieldId: s.field.id } })).toBe(0);
    });
  });

  // ───────────────────────── Blocages ─────────────────────────

  describe('blocages', () => {
    it('le MANAGER bloque une période de plusieurs heures : créneaux BLOCKED côté complexe, UNAVAILABLE côté public', async () => {
      const s = await setup();
      const res = await block(s, s.manager, '14:00', '17:00', { reason: 'Réfection du gazon' });

      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({
        bookingType: 'BLOCK',
        status: 'CONFIRMED',
        note: 'Réfection du gazon',
        customer: null,
        totalMinor: 0,
        commissionMinor: 0,
      });

      const manage = (
        await get(t, `${base(s)}/availability?date=${DATE}`, s.staff.accessToken)
      ).json();
      const statusAt = (hhmm: string) =>
        manage.fields[0].slots.find((x: { startsAt: string }) => x.startsAt === iso(hhmm)).status;
      expect(['13:00', '14:00', '15:00', '16:00', '17:00'].map(statusAt)).toEqual([
        'AVAILABLE',
        'BLOCKED',
        'BLOCKED',
        'BLOCKED',
        'AVAILABLE',
      ]);
      expect(await publicStatus(s, '15:00')).toBe('UNAVAILABLE');
    });

    it('une période qui ne suit pas la grille (19:30 → 21:15) bloque tous les créneaux qu’elle touche', async () => {
      const s = await setup();
      const res = await post(
        t,
        `${base(s)}/blocks`,
        {
          fieldId: s.field.id,
          startsAt: new Date(slotAt(DATE, '19:30')).toISOString(),
          endsAt: new Date(slotAt(DATE, '21:15')).toISOString(),
        },
        bearer(s.manager.accessToken),
      );
      expect(res.statusCode).toBe(201);
      expect(await publicStatus(s, '18:00')).toBe('AVAILABLE');
      expect(await publicStatus(s, '19:00')).toBe('UNAVAILABLE');
      expect(await publicStatus(s, '20:00')).toBe('UNAVAILABLE');
      expect(await publicStatus(s, '21:00')).toBe('UNAVAILABLE');
      expect(await publicStatus(s, '22:00')).toBe('AVAILABLE');
    });

    it('un blocage sur une réservation existante est refusé (409) et LISTE les réservations gênantes', async () => {
      const s = await setup();
      const existing = await book(s.ids, DATE, '15:00');
      const res = await block(s, s.manager, '14:00', '17:00');

      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('SLOT_UNAVAILABLE');
      expect(res.json().error.details.conflicts).toEqual([
        expect.objectContaining({
          id: existing.id,
          reference: existing.reference,
          startsAt: iso('15:00'),
          type: 'STANDARD',
        }),
      ]);
      expect(
        await prisma.booking.count({ where: { fieldId: s.field.id, bookingType: 'BLOCK' } }),
      ).toBe(0);
    });

    it('un joueur ne peut plus réserver un créneau bloqué', async () => {
      const s = await setup();
      await block(s, s.manager, '14:00', '15:00');
      const player = await verifiedSignup(t);
      const res = await post(
        t,
        '/bookings',
        { fieldId: s.field.id, startsAt: iso('14:00') },
        { ...bearer(player.accessToken), 'idempotency-key': randomUUID() },
      );
      expect(res.statusCode).toBe(409);
    });

    it('lever un blocage rouvre le créneau, journalise, et n’est possible qu’une fois', async () => {
      const s = await setup();
      const created = (await block(s, s.manager, '14:00', '16:00')).json();
      expect(
        (await del(t, `${base(s)}/blocks/${created.id}`, s.manager.accessToken)).statusCode,
      ).toBe(204);
      expect(await publicStatus(s, '14:00')).toBe('AVAILABLE');
      expect((await prisma.booking.findUniqueOrThrow({ where: { id: created.id } })).status).toBe(
        'CANCELLED',
      );
      expect(
        await prisma.auditLog.count({ where: { action: 'booking.unblock', entityId: created.id } }),
      ).toBe(1);
      expect(
        (await del(t, `${base(s)}/blocks/${created.id}`, s.manager.accessToken)).statusCode,
      ).toBe(404);
    });

    it('le STAFF ne peut ni bloquer ni lever un blocage (403) ; un non-membre reçoit 404', async () => {
      const s = await setup();
      expect((await block(s, s.staff, '14:00', '15:00')).statusCode).toBe(403);
      const created = (await block(s, s.manager, '14:00', '15:00')).json();
      expect(
        (await del(t, `${base(s)}/blocks/${created.id}`, s.staff.accessToken)).statusCode,
      ).toBe(403);
      expect((await block(s, s.outsider, '16:00', '17:00')).statusCode).toBe(404);
      expect(
        (await del(t, `${base(s)}/blocks/${created.id}`, s.outsider.accessToken)).statusCode,
      ).toBe(404);
    });

    it('lever un blocage ne peut pas annuler une VRAIE réservation, ni toucher un autre complexe', async () => {
      const s = await setup();
      const other = await setup();
      const real = await book(s.ids, DATE, '10:00');
      expect((await del(t, `${base(s)}/blocks/${real.id}`, s.manager.accessToken)).statusCode).toBe(
        404,
      );
      expect((await prisma.booking.findUniqueOrThrow({ where: { id: real.id } })).status).toBe(
        'CONFIRMED',
      );

      const otherBlock = (await block(other, other.manager, '14:00', '15:00')).json();
      expect(
        (await del(t, `${base(s)}/blocks/${otherBlock.id}`, s.manager.accessToken)).statusCode,
      ).toBe(404);
      expect(
        (await prisma.booking.findUniqueOrThrow({ where: { id: otherBlock.id } })).status,
      ).toBe('CONFIRMED');
    });

    it('un blocage reste invisible pour les joueurs (liste, détail, annulation)', async () => {
      const s = await setup();
      const created = (await block(s, s.manager, '14:00', '15:00')).json();
      const player = await verifiedSignup(t);
      expect((await get(t, '/bookings?when=all', player.accessToken)).json().items).toEqual([]);
      expect((await get(t, `/bookings/${created.id}`, player.accessToken)).statusCode).toBe(404);
    });

    it.each([
      ['période terminée', (s: Setup) => block(s, s.manager, '10:00', '11:00', {}, dayIn(-3))],
      [
        'fin avant le début',
        (s: Setup) =>
          post(
            t,
            `${base(s)}/blocks`,
            { fieldId: s.field.id, startsAt: iso('12:00'), endsAt: iso('11:00') },
            bearer(s.manager.accessToken),
          ),
      ],
      [
        'plus de 31 jours',
        (s: Setup) =>
          post(
            t,
            `${base(s)}/blocks`,
            {
              fieldId: s.field.id,
              startsAt: iso('12:00'),
              endsAt: slotAt(dayIn(50), '12:00').toISOString(),
            },
            bearer(s.manager.accessToken),
          ),
      ],
      [
        'champ interdit',
        (s: Setup) => block(s, s.manager, '12:00', '13:00', { bookingType: 'STANDARD' }),
      ],
    ])('refuse : %s', async (_label, run) => {
      const s = await setup();
      const res = await run(s);
      expect([400, 422]).toContain(res.statusCode);
      expect(await prisma.booking.count({ where: { fieldId: s.field.id } })).toBe(0);
    });

    it('refuse le terrain d’un autre complexe (404)', async () => {
      const s = await setup();
      const other = await setup();
      const res = await post(
        t,
        `${base(s)}/blocks`,
        { fieldId: other.field.id, startsAt: iso('12:00'), endsAt: iso('13:00') },
        bearer(s.manager.accessToken),
      );
      expect(res.statusCode).toBe(404);
    });
  });

  // ───────────────────────── Annulation par le complexe ─────────────────────────

  describe('POST /manage/venues/:id/bookings/:id/cancel', () => {
    async function paid(s: Setup, startsInHours: number) {
      const player = await verifiedSignup(t);
      const start = new Date(Date.now() + startsInHours * 3_600_000);
      start.setMinutes(0, 0, 0);
      const booking = await prisma.booking.create({
        data: bookingData(s.ids, { userId: player.userId, start }),
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
      return { player, booking, payment };
    }
    const cancel = (
      s: Setup,
      user: Signup,
      id: string,
      body: object = { reason: 'Terrain inutilisable' },
    ) => post(t, `${base(s)}/bookings/${id}/cancel`, body, bearer(user.accessToken));

    it('le MANAGER annule : le client est remboursé INTÉGRALEMENT, même à quelques heures du match', async () => {
      const s = await setup();
      const { booking, payment } = await paid(s, 3); // bien en deçà du délai gratuit de 24 h
      const res = await cancel(s, s.manager, booking.id);

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        booking: { status: 'CANCELLED', cancellationReason: 'Terrain inutilisable' },
        refundRequestedMinor: 800,
      });
      const refund = await prisma.refund.findFirstOrThrow({ where: { bookingId: booking.id } });
      expect(refund).toMatchObject({
        paymentId: payment.id,
        amountMinor: 800,
        status: 'REQUESTED',
        requestedById: s.manager.userId,
      });
      expect(
        await prisma.auditLog.count({
          where: { action: 'booking.cancel_by_venue', entityId: booking.id },
        }),
      ).toBe(1);
    });

    it('exige une raison, refuse au STAFF (403) et aux étrangers (404)', async () => {
      const s = await setup();
      const { booking } = await paid(s, 48);
      expect((await cancel(s, s.manager, booking.id, {})).statusCode).toBe(400);
      expect((await cancel(s, s.staff, booking.id)).statusCode).toBe(403);
      expect((await cancel(s, s.outsider, booking.id)).statusCode).toBe(404);
      expect((await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe(
        'CONFIRMED',
      );
    });

    it('ne touche pas une réservation d’un AUTRE complexe', async () => {
      const s = await setup();
      const other = await setup();
      const { booking } = await paid(other, 48);
      expect((await cancel(s, s.manager, booking.id)).statusCode).toBe(404);
      expect((await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe(
        'CONFIRMED',
      );
    });

    it('refuse : déjà annulée, déjà commencée, blocage (404) ; deux annulations simultanées → un seul remboursement', async () => {
      const s = await setup();
      const { booking } = await paid(s, 48);
      const results = await Promise.all([
        cancel(s, s.manager, booking.id),
        cancel(s, s.owner, booking.id),
        cancel(s, s.manager, booking.id),
      ]);
      expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
      expect(await prisma.refund.count({ where: { bookingId: booking.id } })).toBe(1);

      const started = await prisma.booking.create({
        data: bookingData(s.ids, {
          userId: s.owner.userId,
          start: new Date(Date.now() - 30 * 60_000),
        }),
      });
      expect((await cancel(s, s.manager, started.id)).statusCode).toBe(409);

      const blk = (await block(s, s.manager, '14:00', '15:00')).json();
      expect((await cancel(s, s.manager, blk.id)).statusCode).toBe(404);
    });

    it('libère le créneau pour d’autres joueurs', async () => {
      const s = await setup();
      const player = await verifiedSignup(t);
      const created = await post(
        t,
        '/bookings',
        { fieldId: s.field.id, startsAt: iso('12:00') },
        { ...bearer(player.accessToken), 'idempotency-key': randomUUID() },
      );
      expect(await publicStatus(s, '12:00')).toBe('HELD');
      await cancel(s, s.manager, created.json().id);
      expect(await publicStatus(s, '12:00')).toBe('AVAILABLE');
    });
  });

  // ───────────────────────── Absence ─────────────────────────

  describe('POST /manage/venues/:id/bookings/:id/no-show', () => {
    const started = (s: Setup, userId: string | null, minutesAgo = 30) =>
      prisma.booking.create({
        data: bookingData(s.ids, { userId, start: new Date(Date.now() - minutesAgo * 60_000) }),
      });
    const noShow = (s: Setup, user: Signup, id: string) =>
      post(t, `${base(s)}/bookings/${id}/no-show`, undefined, bearer(user.accessToken));

    it('marque le joueur absent : le créneau reste occupé et sa fiabilité baisse', async () => {
      const s = await setup();
      const player = await verifiedSignup(t);
      const booking = await started(s, player.userId);

      const res = await noShow(s, s.staff, booking.id);
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('NO_SHOW');

      const stats = await prisma.playerStats.findUniqueOrThrow({
        where: { userId: player.userId },
      });
      expect(stats).toMatchObject({ noShowCount: 1, reliabilityScore: 100 - NO_SHOW_PENALTY });
      expect(
        await prisma.auditLog.count({ where: { action: 'booking.no_show', entityId: booking.id } }),
      ).toBe(1);
    });

    it('chaque absence retire des points, sans jamais passer sous 0', async () => {
      const s = await setup();
      const player = await verifiedSignup(t);
      const anchor = Date.now(); // un seul instant de référence : des créneaux d'1 h bout à bout, sans chevauchement
      for (let i = 0; i < 12; i++) {
        const b = await prisma.booking.create({
          data: bookingData(s.ids, {
            userId: player.userId,
            start: new Date(anchor - (60 + i * 60) * 60_000),
          }),
        });
        await noShow(s, s.staff, b.id);
      }
      const stats = await prisma.playerStats.findUniqueOrThrow({
        where: { userId: player.userId },
      });
      expect(stats.noShowCount).toBe(12);
      expect(stats.reliabilityScore).toBe(0);
    });

    it('deux marquages simultanés de la même réservation : comptés UNE seule fois', async () => {
      const s = await setup();
      const player = await verifiedSignup(t);
      const booking = await started(s, player.userId);
      const results = await Promise.all([
        noShow(s, s.staff, booking.id),
        noShow(s, s.manager, booking.id),
        noShow(s, s.owner, booking.id),
      ]);
      expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
      expect(
        (await prisma.playerStats.findUniqueOrThrow({ where: { userId: player.userId } }))
          .noShowCount,
      ).toBe(1);
    });

    it('fonctionne pour un client sans compte (réservation manuelle) sans statistiques', async () => {
      const s = await setup();
      const manualBooking = await prisma.booking.create({
        data: bookingData(s.ids, { userId: null, start: new Date(Date.now() - 30 * 60_000) }),
      });
      expect((await noShow(s, s.staff, manualBooking.id)).statusCode).toBe(200);
      expect(
        (await prisma.booking.findUniqueOrThrow({ where: { id: manualBooking.id } })).status,
      ).toBe('NO_SHOW');
    });

    it('refuse : créneau pas encore commencé, réservation non confirmée, blocage, autre complexe, non-membre', async () => {
      const s = await setup();
      const other = await setup();
      const player = await verifiedSignup(t);
      const future = await book(s.ids, DATE, '10:00', { userId: player.userId });
      const cancelled = await prisma.booking.create({
        data: {
          ...bookingData(s.ids, {
            userId: player.userId,
            start: new Date(Date.now() - 3 * 3_600_000),
          }),
          status: 'CANCELLED',
        },
      });
      const blk = (await block(s, s.manager, '14:00', '15:00')).json();
      const foreign = await started(other, player.userId);
      const mine = await started(s, player.userId, 200);

      expect((await noShow(s, s.staff, future.id)).statusCode).toBe(409);
      expect((await noShow(s, s.staff, cancelled.id)).statusCode).toBe(409);
      expect((await noShow(s, s.staff, blk.id)).statusCode).toBe(404);
      expect((await noShow(s, s.staff, foreign.id)).statusCode).toBe(404);
      expect((await noShow(s, s.outsider, mine.id)).statusCode).toBe(404);
      expect(
        await prisma.playerStats.count({
          where: { userId: player.userId, noShowCount: { gt: 0 } },
        }),
      ).toBe(0);
    });
  });
});

// ───────────────────────── Maintenance ─────────────────────────

describe('maintenance périodique des réservations', () => {
  let t: TestApp;
  let maintenance: import('../../src/modules/bookings/bookings-maintenance.service.js').BookingsMaintenanceService;

  beforeAll(async () => {
    await resetDb();
    await seedBaseline(prisma);
    t = await createTestApp();
    const { BookingsMaintenanceService } =
      await import('../../src/modules/bookings/bookings-maintenance.service.js');
    maintenance = t.app.get(BookingsMaintenanceService);
  });
  afterAll(() => t.close());

  const fixture = async () => {
    const { venue, fields } = await createVenueWithFields();
    return { fieldId: fields[0]!.id, venueId: venue.id };
  };

  it('fait expirer les verrous périmés et laisse les verrous valides', async () => {
    const ids = await fixture();
    const stale = await book(ids, DATE, '10:00', {
      status: 'PENDING_PAYMENT',
      holdExpiresAt: inMinutes(-1),
    });
    const valid = await book(ids, DATE, '11:00', {
      status: 'PENDING_PAYMENT',
      holdExpiresAt: inMinutes(5),
    });

    const result = await maintenance.runOnce();
    expect(result.ran).toBe(true);
    expect(result.expiredHolds).toBeGreaterThanOrEqual(1);
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: stale.id } })).status).toBe(
      'EXPIRED',
    );
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: valid.id } })).status).toBe(
      'PENDING_PAYMENT',
    );
  });

  it('termine les réservations passées et crédite les matchs joués ; ignore blocs, annulées et futures', async () => {
    const ids = await fixture();
    const user = await signup(t);
    const [a, b, c] = [3, 2, 1].map((h) => new Date(Date.now() - h * 3_600_000 - 3_600_000));
    const done1 = await prisma.booking.create({
      data: bookingData(ids, { userId: user.userId, start: a }),
    });
    const done2 = await prisma.booking.create({
      data: bookingData(ids, { userId: user.userId, start: b }),
    });
    const manualDone = await prisma.booking.create({
      data: bookingData(ids, { userId: null, start: c }),
    });
    const blockPast = await prisma.booking.create({
      data: bookingData(ids, {
        bookingType: 'BLOCK',
        start: new Date(Date.now() - 10 * 3_600_000),
      }),
    });
    const cancelledPast = await prisma.booking.create({
      data: bookingData(ids, {
        userId: user.userId,
        start: new Date(Date.now() - 20 * 3_600_000),
        status: 'CANCELLED',
      }),
    });
    const future = await book(ids, DATE, '10:00', { userId: user.userId });

    await maintenance.runOnce();

    const status = async (id: string) =>
      (await prisma.booking.findUniqueOrThrow({ where: { id } })).status;
    expect(await status(done1.id)).toBe('COMPLETED');
    expect(await status(done2.id)).toBe('COMPLETED');
    expect(await status(manualDone.id)).toBe('COMPLETED');
    expect(await status(blockPast.id)).toBe('CONFIRMED'); // un blocage n'est pas un match
    expect(await status(cancelledPast.id)).toBe('CANCELLED');
    expect(await status(future.id)).toBe('CONFIRMED');

    const stats = await prisma.playerStats.findUniqueOrThrow({ where: { userId: user.userId } });
    expect(stats.matchesPlayed).toBe(2); // uniquement les 2 réservations réellement jouées de ce joueur
  });

  it('est idempotent : une seconde exécution ne change rien ni ne double-compte', async () => {
    const ids = await fixture();
    const user = await signup(t);
    await prisma.booking.create({
      data: bookingData(ids, { userId: user.userId, start: new Date(Date.now() - 5 * 3_600_000) }),
    });
    await maintenance.runOnce();
    const again = await maintenance.runOnce();
    expect(again).toMatchObject({ ran: true, completedBookings: 0, expiredHolds: 0 });
    expect(
      (await prisma.playerStats.findUniqueOrThrow({ where: { userId: user.userId } }))
        .matchesPlayed,
    ).toBe(1);
  });

  it('purge les clés d’idempotence expirées et garde les autres', async () => {
    const user = await signup(t);
    await prisma.idempotencyKey.createMany({
      data: [
        {
          userId: user.userId,
          key: 'expired-key-1',
          endpoint: 'POST /bookings',
          requestHash: 'x',
          expiresAt: new Date(Date.now() - 1000),
        },
        {
          userId: user.userId,
          key: 'valid-key-001',
          endpoint: 'POST /bookings',
          requestHash: 'x',
          expiresAt: new Date(Date.now() + 3_600_000),
        },
      ],
    });
    const result = await maintenance.runOnce();
    expect(result.purgedKeys).toBeGreaterThanOrEqual(1);
    const left = await prisma.idempotencyKey.findMany({ where: { userId: user.userId } });
    expect(left.map((k) => k.key)).toEqual(['valid-key-001']);
  });

  it('une seule instance à la fois : si une autre exécute déjà la maintenance, celle-ci se retire', async () => {
    const ids = await fixture();
    const stale = await book(ids, DATE, '12:00', {
      status: 'PENDING_PAYMENT',
      holdExpiresAt: inMinutes(-1),
    });

    const concurrent = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(727001)`; // « l'autre instance » tient le verrou
      return maintenance.runOnce();
    });

    expect(concurrent.ran).toBe(false);
    expect(concurrent.expiredHolds).toBe(0);
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: stale.id } })).status).toBe(
      'PENDING_PAYMENT',
    );
    expect((await maintenance.runOnce()).ran).toBe(true); // verrou relâché : la maintenance reprend
  });
});
