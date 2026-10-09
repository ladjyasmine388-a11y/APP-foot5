import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedBaseline } from '../../src/infra/database/baseline.js';
import { DomainEvents } from '../../src/infra/events/domain-events.js';
import { NotificationsService } from '../../src/modules/notifications/notifications.service.js';
import { RemindersService } from '../../src/modules/notifications/reminders.service.js';
import { type Signup, type TestApp, bearer, createTestApp, del, get, post } from './app-helper.js';
import { prisma, resetDb } from './helpers.js';
import { type World, confirmedBooking, createWorld, makeTeam, newPlayer } from './social-fixtures.js';

describe('notifications', () => {
  let t: TestApp;
  let w: World;

  beforeAll(async () => {
    await resetDb();
    await seedBaseline(prisma);
    t = await createTestApp();
    w = await createWorld(t);
  });
  afterAll(() => t.close());
  beforeEach(() => t.rateLimits.reset());

  // ───────────────────────── Outils ─────────────────────────

  const inbox = async (user: Signup, query = '') => (await get(t, `/me/notifications${query}`, user.accessToken)).json();
  const types = async (user: Signup) => (await inbox(user)).items.map((n: { type: string }) => n.type);
  /** Un joueur dont on a vidé la boîte d'emails et de notifications (les inscriptions envoient leurs propres emails). */
  async function fresh(overrides: { locale?: string; preferences?: object } = {}) {
    const user = await newPlayer(t);
    if (overrides.locale || overrides.preferences) {
      await prisma.user.update({ where: { id: user.userId }, data: { locale: overrides.locale, preferences: overrides.preferences } });
    }
    t.mailer.reset();
    return user;
  }
  /** Plusieurs joueurs créés ensemble, puis la boîte d'emails vidée UNE fois (sinon on effacerait les liens de vérification des autres). */
  function freshMany(count: 2): Promise<[Signup, Signup]>;
  function freshMany(count: 3): Promise<[Signup, Signup, Signup]>;
  function freshMany(count: 4): Promise<[Signup, Signup, Signup, Signup]>;
  async function freshMany(count: number): Promise<Signup[]> {
    const users = await Promise.all(Array.from({ length: count }, () => newPlayer(t)));
    t.mailer.reset();
    return users;
  }
  const solo = async (host: Signup, spots = 3) => {
    const booking = await confirmedBooking(w, host);
    return (await post(t, '/solo-sessions', { bookingId: booking.id, spots }, bearer(host.accessToken))).json() as { id: string; matchId: string };
  };

  // ───────────────────────── Réservations ─────────────────────────

  describe('réservations', () => {
    it('annulation de la réservation : notification + email dans la langue du compte', async () => {
      const user = await fresh({ locale: 'en' });
      const booking = await confirmedBooking(w, user);
      expect((await post(t, `/bookings/${booking.id}/cancel`, {}, bearer(user.accessToken))).statusCode).toBe(200);

      const page = await inbox(user);
      expect(page.unreadCount).toBe(1);
      expect(page.items[0]).toMatchObject({
        type: 'BOOKING_CANCELLED',
        title: 'Booking cancelled',
        read: false,
        data: { bookingId: booking.id, reference: booking.reference, venueName: w.venue.name },
      });
      expect(page.items[0].body).toContain(booking.reference);
      const mails = t.mailer.to(user.email);
      expect(mails).toHaveLength(1);
      expect(mails[0]?.subject).toBe('Booking cancelled — Foot Five');
    });

    it('en arabe pour un compte arabe', async () => {
      const user = await fresh({ locale: 'ar' });
      const booking = await confirmedBooking(w, user);
      await t.app.get(DomainEvents).emit('booking.confirmed', { bookingId: booking.id });
      const [first] = (await inbox(user)).items;
      expect(first.title).toMatch(/[؀-ۿ]/);
      expect(t.mailer.to(user.email)[0]?.subject).toMatch(/[؀-ۿ]/);
    });

    it('réservation confirmée / expirée : une notification chacune ; une réservation sans compte n’en génère aucune', async () => {
      const user = await fresh();
      const booking = await confirmedBooking(w, user);
      const bus = t.app.get(DomainEvents);
      await bus.emit('booking.confirmed', { bookingId: booking.id });
      await bus.emit('booking.expired', { bookingIds: [booking.id] });
      expect(await types(user)).toEqual(['BOOKING_EXPIRED', 'BOOKING_CONFIRMED']);

      const manual = await confirmedBooking(w, null);
      await bus.emit('booking.confirmed', { bookingId: manual.id });
      expect(await prisma.notification.count({ where: { payload: { path: ['bookingId'], equals: manual.id } } })).toBe(0);
    });

    it('remboursement effectué : montant et référence, jamais de données de paiement', async () => {
      const user = await fresh();
      const booking = await confirmedBooking(w, user);
      const payment = await prisma.payment.create({
        data: { bookingId: booking.id, provider: 'fake', kind: 'DEPOSIT', amountMinor: 800, status: 'REFUNDED', paidAt: new Date(), idempotencyKey: randomUUID() },
      });
      const refund = await prisma.refund.create({ data: { paymentId: payment.id, bookingId: booking.id, amountMinor: 800, status: 'SUCCEEDED' } });
      await t.app.get(DomainEvents).emit('refund.processed', { refundId: refund.id, bookingId: booking.id });

      const [first] = (await inbox(user)).items;
      expect(first).toMatchObject({ type: 'REFUND_PROCESSED', data: { amountMinor: 800, reference: booking.reference } });
      expect(first.body).toContain('800');
      expect(JSON.stringify(first)).not.toContain(payment.idempotencyKey);
    });
  });

  // ───────────────────────── Préférences et exclusions ─────────────────────────

  describe('qui est prévenu, et comment', () => {
    it('un compte qui a désactivé les emails garde la notification dans l’application', async () => {
      const user = await fresh({ preferences: { emailNotifications: false } });
      const booking = await confirmedBooking(w, user);
      await post(t, `/bookings/${booking.id}/cancel`, {}, bearer(user.accessToken));
      expect(await types(user)).toEqual(['BOOKING_CANCELLED']);
      expect(t.mailer.to(user.email)).toHaveLength(0);
    });

    it('pas d’email tant que l’adresse n’est pas vérifiée (la notification, elle, existe)', async () => {
      const { signup } = await import('./app-helper.js');
      const user = await signup(t);
      t.mailer.reset();
      const booking = await confirmedBooking(w, user);
      await t.app.get(DomainEvents).emit('booking.confirmed', { bookingId: booking.id });
      expect(await types(user)).toEqual(['BOOKING_CONFIRMED']);
      expect(t.mailer.to(user.email)).toHaveLength(0);
    });

    it('un compte bloqué ou supprimé ne reçoit rien', async () => {
      const user = await fresh();
      await prisma.user.update({ where: { id: user.userId }, data: { status: 'BLOCKED' } });
      await t.app.get(NotificationsService).notify(user.userId, 'MATCH_CANCELLED', { venueName: 'X' });
      expect(await prisma.notification.count({ where: { userId: user.userId } })).toBe(0);
      await t.app.get(NotificationsService).notify(randomUUID(), 'MATCH_CANCELLED', { venueName: 'X' }); // compte inconnu : sans erreur
    });

    it('une panne d’envoi d’email ne fait échouer ni la notification ni l’action', async () => {
      const user = await fresh();
      const booking = await confirmedBooking(w, user);
      const original = t.mailer.send.bind(t.mailer);
      t.mailer.send = () => Promise.reject(new Error('SMTP indisponible'));
      try {
        expect((await post(t, `/bookings/${booking.id}/cancel`, {}, bearer(user.accessToken))).statusCode).toBe(200);
      } finally {
        t.mailer.send = original;
      }
      expect(await types(user)).toEqual(['BOOKING_CANCELLED']);
    });
  });

  // ───────────────────────── Équipes ─────────────────────────

  it('invitation d’équipe : l’invité est prévenu (app + email), le capitaine l’est quand il accepte (app seulement)', async () => {
    const [captain, player] = await freshMany(2);
    const team = await makeTeam(t, captain, 1);
    const inv = (await post(t, `/teams/${team.id}/invitations`, { userId: player.userId }, bearer(captain.accessToken))).json();

    const [received] = (await inbox(player)).items;
    expect(received).toMatchObject({ type: 'TEAM_INVITATION_RECEIVED', data: { invitationId: inv.id, teamId: team.id, teamName: team.name } });
    expect(received.data.invitedBy).toMatch(/^\S+ \S+$/);
    expect(t.mailer.to(player.email)).toHaveLength(1);
    expect(JSON.stringify(received)).not.toContain(captain.email);

    await post(t, `/invitations/${inv.id}/accept`, undefined, bearer(player.accessToken));
    const [joined] = (await inbox(captain)).items;
    expect(joined).toMatchObject({ type: 'TEAM_INVITATION_ACCEPTED', data: { teamName: team.name } });
    expect(t.mailer.to(captain.email)).toHaveLength(0);
  });

  // ───────────────────────── Sessions ─────────────────────────

  describe('sessions « Complétez votre équipe »', () => {
    it('presque complète, complète, puis annulée : l’hôte et les joueurs sont prévenus aux bons moments', async () => {
      const host = await fresh();
      const session = await solo(host, 4);
      const [a, b, c, d] = await freshMany(4);
      const join = (u: Signup) => post(t, `/solo-sessions/${session.id}/join`, undefined, bearer(u.accessToken));

      await join(a); // 3 places restantes : rien à signaler
      expect(await types(host)).toEqual([]);
      await join(b); // 2 restantes
      expect(await types(host)).toEqual(['SOLO_ALMOST_FULL']);
      await join(c);
      await join(d); // complète

      const hostTypes = await types(host);
      expect(hostTypes.filter((x: string) => x === 'SOLO_ALMOST_FULL')).toHaveLength(2);
      expect(hostTypes).toContain('SOLO_FULL');
      for (const player of [a, b, c, d]) expect(await types(player)).toEqual(['SOLO_FULL']);
      expect(t.mailer.to(a.email)).toHaveLength(1);
      expect(t.mailer.to(host.email).length).toBe(1); // SOLO_FULL seulement : « presque complète » reste dans l'application

      await del(t, `/solo-sessions/${session.id}`, host.accessToken);
      for (const player of [a, b, c, d]) expect((await types(player))[0]).toBe('SOLO_CANCELLED');
    });
  });

  // ───────────────────────── Adversaires et matchs ─────────────────────────

  describe('adversaires et matchs', () => {
    async function setup() {
      const [capA, capB, capC] = await freshMany(3);
      const [teamA, teamB, teamC] = await Promise.all([makeTeam(t, capA, 5), makeTeam(t, capB, 5), makeTeam(t, capC, 5)]);
      const booking = await confirmedBooking(w, capA);
      const listing = (await post(t, '/opponent-listings', { teamId: teamA.id, bookingId: booking.id }, bearer(capA.accessToken))).json();
      return { capA, capB, capC, teamA, teamB, teamC, booking, listing };
    }
    const ask = (cap: Signup, listingId: string, teamId: string) => post(t, `/opponent-listings/${listingId}/requests`, { teamId }, bearer(cap.accessToken));

    it('demande reçue → capitaine annonceur ; acceptée / refusée → capitaines demandeurs', async () => {
      const { capA, capB, capC, teamB, teamC, listing } = await setup();
      const reqB = (await ask(capB, listing.id, teamB.id)).json();
      await ask(capC, listing.id, teamC.id);

      const received = (await inbox(capA)).items.filter((n: { type: string }) => n.type === 'OPPONENT_REQUEST_RECEIVED');
      expect(received).toHaveLength(2);
      expect(received.map((n: { data: { teamName: string } }) => n.data.teamName).sort()).toEqual([teamB.name, teamC.name].sort());

      await post(t, `/opponent-listings/${listing.id}/requests/${reqB.id}/accept`, undefined, bearer(capA.accessToken));
      const accepted = (await inbox(capB)).items[0];
      expect(accepted).toMatchObject({ type: 'OPPONENT_ACCEPTED', data: { venueName: w.venue.name } });
      expect((await inbox(capB)).items.filter((n: { type: string }) => n.type === 'OPPONENT_ACCEPTED')).toHaveLength(1); // capitaine = demandeur : une seule fois
      expect((await inbox(capC)).items[0]).toMatchObject({ type: 'OPPONENT_REJECTED' });
      expect(t.mailer.to(capB.email).length).toBeGreaterThanOrEqual(1);
    });

    it('annulation d’un match : tous les participants ; retrait de l’adversaire : l’équipe annonceuse aussi, malgré la suppression du match', async () => {
      const { capA, capB, teamB, teamA, listing } = await setup();
      const req = (await ask(capB, listing.id, teamB.id)).json();
      const match = (await post(t, `/opponent-listings/${listing.id}/requests/${req.id}/accept`, undefined, bearer(capA.accessToken))).json();

      await post(t, `/matches/${match.id}/cancel`, undefined, bearer(capB.accessToken)); // retrait : le match est supprimé
      expect(await prisma.match.count({ where: { id: match.id } })).toBe(0);
      const ownerNotifs = (await inbox(capA)).items.filter((n: { type: string }) => n.type === 'MATCH_CANCELLED');
      expect(ownerNotifs).toHaveLength(1);
      expect(ownerNotifs[0].data).toMatchObject({ matchId: match.id, venueName: w.venue.name });
      expect(ownerNotifs[0].body).not.toContain('—');
      const member = teamA.members[0]!;
      expect(await prisma.notification.count({ where: { userId: member.userId, type: 'MATCH_CANCELLED' } })).toBe(1);
    });
  });

  // ───────────────────────── API de la boîte de réception ─────────────────────────

  describe('GET /me/notifications', () => {
    async function seed(user: Signup, count: number) {
      const service = t.app.get(NotificationsService);
      for (let i = 0; i < count; i++) await service.notify(user.userId, 'MATCH_CANCELLED', { matchId: `m${i}`, venueName: `Lieu ${i}`, startsAt: new Date().toISOString() });
    }

    it('pagine du plus récent au plus ancien, avec le compteur de non lues', async () => {
      const user = await fresh();
      await seed(user, 5);
      const page1 = await inbox(user, '?limit=2');
      expect(page1.items.map((n: { data: { venueName: string } }) => n.data.venueName)).toEqual(['Lieu 4', 'Lieu 3']);
      expect(page1.unreadCount).toBe(5);
      const page2 = await inbox(user, `?limit=2&cursor=${page1.nextCursor}`);
      expect(page2.items.map((n: { data: { venueName: string } }) => n.data.venueName)).toEqual(['Lieu 2', 'Lieu 1']);
      const page3 = await inbox(user, `?limit=2&cursor=${page2.nextCursor}`);
      expect(page3.items).toHaveLength(1);
      expect(page3.nextCursor).toBeNull();
      expect((await get(t, '/me/notifications?limit=0', user.accessToken)).statusCode).toBe(400);
      expect((await get(t, '/me/notifications?cursor=%%', user.accessToken)).statusCode).toBe(400);
    });

    it('marquer lu (une / toutes), filtrer les non lues, compteur', async () => {
      const user = await fresh();
      await seed(user, 3);
      const items = (await inbox(user)).items;
      expect((await post(t, `/me/notifications/${items[0].id}/read`, undefined, bearer(user.accessToken))).statusCode).toBe(204);
      expect((await post(t, `/me/notifications/${items[0].id}/read`, undefined, bearer(user.accessToken))).statusCode).toBe(204); // idempotent

      expect((await get(t, '/me/notifications/unread-count', user.accessToken)).json()).toEqual({ count: 2 });
      expect((await inbox(user, '?unread=true')).items).toHaveLength(2);
      const all = await post(t, '/me/notifications/read-all', undefined, bearer(user.accessToken));
      expect(all.json()).toEqual({ updated: 2 });
      expect((await inbox(user, '?unread=true')).items).toHaveLength(0);
      expect((await inbox(user)).items.every((n: { read: boolean }) => n.read)).toBe(true);
    });

    it('chacun ne voit et ne modifie que SES notifications (404 pour celles des autres)', async () => {
      const [alice, bob] = await freshMany(2);
      await seed(alice, 2);
      await seed(bob, 1);
      const aliceFirst = (await inbox(alice)).items[0];
      expect((await inbox(bob)).items.map((n: { id: string }) => n.id)).not.toContain(aliceFirst.id);
      expect((await post(t, `/me/notifications/${aliceFirst.id}/read`, undefined, bearer(bob.accessToken))).statusCode).toBe(404);
      expect((await inbox(alice)).unreadCount).toBe(2);
      expect((await post(t, '/me/notifications/read-all', undefined, bearer(bob.accessToken))).json()).toEqual({ updated: 1 });
      expect((await inbox(alice)).unreadCount).toBe(2);
      expect((await get(t, '/me/notifications')).statusCode).toBe(401);
      expect((await post(t, '/me/notifications/pas-un-uuid/read', undefined, bearer(bob.accessToken))).statusCode).toBe(400);
    });

    it('ne contient jamais d’email ni de téléphone d’un autre joueur', async () => {
      const [captain, player] = await freshMany(2);
      const team = await makeTeam(t, captain, 1);
      await post(t, `/teams/${team.id}/invitations`, { userId: player.userId }, bearer(captain.accessToken));
      const raw = JSON.stringify(await inbox(player));
      expect(raw).not.toContain(captain.email);
      expect(raw).not.toMatch(/\+?213\d{8,9}|phone/i);
    });
  });

  // ───────────────────────── Rappels et ménage ─────────────────────────

  describe('rappels de match', () => {
    async function teamMatch() {
      const cap = await fresh();
      const team = await makeTeam(t, cap, 3);
      const booking = await confirmedBooking(w, cap);
      const match = (await post(t, '/matches', { teamId: team.id, bookingId: booking.id }, bearer(cap.accessToken))).json() as { id: string };
      return { cap, team, booking, match };
    }

    it('un seul rappel par match, dans les 24 h, à tous les participants — rejoué sans effet', async () => {
      const { cap, team, booking, match } = await teamMatch();
      const reminders = t.app.get(RemindersService);
      const now = new Date(booking.startsAt.getTime() - 12 * 3_600_000);

      expect((await reminders.runOnce(now)).reminded).toBeGreaterThanOrEqual(1);
      expect(await prisma.notification.count({ where: { type: 'MATCH_REMINDER', payload: { path: ['matchId'], equals: match.id } } })).toBe(3);
      expect((await inbox(cap)).items[0]).toMatchObject({ type: 'MATCH_REMINDER', data: { matchId: match.id } });
      expect(t.mailer.to(cap.email).some((m) => m.subject.includes('Rappel'))).toBe(true);
      expect((await prisma.match.findUniqueOrThrow({ where: { id: match.id } })).reminderSentAt).not.toBeNull();

      expect((await reminders.runOnce(now)).reminded).toBe(0);
      expect(await prisma.notification.count({ where: { type: 'MATCH_REMINDER', userId: team.members[0]!.userId } })).toBe(1);
    });

    it('pas de rappel : match trop lointain, match annulé, réservation annulée, match créé il y a moins d’une heure', async () => {
      const far = await teamMatch();
      const cancelled = await teamMatch();
      await post(t, `/matches/${cancelled.match.id}/cancel`, undefined, bearer(cancelled.cap.accessToken));
      const bookingGone = await teamMatch();
      await prisma.booking.update({ where: { id: bookingGone.booking.id }, data: { status: 'CANCELLED' } });
      const reminders = t.app.get(RemindersService);

      // 48 h avant le premier match seulement : rien n'est dans la fenêtre de 24 h, sauf éventuellement des matchs d'autres tests
      await reminders.runOnce(new Date(far.booking.startsAt.getTime() - 48 * 3_600_000));
      for (const m of [far, cancelled, bookingGone]) {
        expect((await prisma.match.findUniqueOrThrow({ where: { id: m.match.id } })).reminderSentAt, m.match.id).toBeNull();
      }
      await reminders.runOnce(new Date(far.booking.startsAt.getTime() - 6 * 3_600_000));
      expect((await prisma.match.findUniqueOrThrow({ where: { id: far.match.id } })).reminderSentAt).not.toBeNull();
      expect((await prisma.match.findUniqueOrThrow({ where: { id: cancelled.match.id } })).reminderSentAt).toBeNull();
      expect((await prisma.match.findUniqueOrThrow({ where: { id: bookingGone.match.id } })).reminderSentAt).toBeNull();

      const recent = await teamMatch();
      await prisma.match.update({ where: { id: recent.match.id }, data: { startsAt: new Date(Date.now() + 5 * 3_600_000) } });
      await reminders.runOnce(); // créé à l'instant : pas de rappel inutile
      expect((await prisma.match.findUniqueOrThrow({ where: { id: recent.match.id } })).reminderSentAt).toBeNull();
      await reminders.runOnce(new Date(Date.now() + 2 * 3_600_000));
      expect((await prisma.match.findUniqueOrThrow({ where: { id: recent.match.id } })).reminderSentAt).not.toBeNull();
    });

    it('la base refuse un second rappel du même match au même joueur', async () => {
      const { cap, match } = await teamMatch();
      const service = t.app.get(NotificationsService);
      await service.notify(cap.userId, 'MATCH_REMINDER', { matchId: match.id, venueName: 'X' });
      await service.notify(cap.userId, 'MATCH_REMINDER', { matchId: match.id, venueName: 'X' });
      expect(await prisma.notification.count({ where: { userId: cap.userId, type: 'MATCH_REMINDER' } })).toBe(1);
    });

    it('le ménage supprime les notifications lues depuis plus de 90 jours et celles de plus d’un an', async () => {
      const user = await fresh();
      const old = new Date(Date.now() - 100 * 86_400_000);
      const ancient = new Date(Date.now() - 400 * 86_400_000);
      const keep = await prisma.notification.create({ data: { userId: user.userId, type: 'MATCH_CANCELLED', payload: {}, createdAt: old } }); // non lue : conservée
      await prisma.notification.create({ data: { userId: user.userId, type: 'MATCH_CANCELLED', payload: {}, createdAt: old, readAt: old } });
      await prisma.notification.create({ data: { userId: user.userId, type: 'MATCH_CANCELLED', payload: {}, createdAt: ancient } });
      const recentRead = await prisma.notification.create({ data: { userId: user.userId, type: 'MATCH_CANCELLED', payload: {}, readAt: new Date() } });

      expect(await t.app.get(NotificationsService).purgeOld()).toBeGreaterThanOrEqual(2);
      const left = (await prisma.notification.findMany({ where: { userId: user.userId } })).map((n) => n.id).sort();
      expect(left).toEqual([keep.id, recentRead.id].sort());
    });
  });
});
