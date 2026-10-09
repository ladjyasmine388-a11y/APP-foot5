import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedBaseline } from '../../src/infra/database/baseline.js';
import { DomainEvents, type DomainEventMap } from '../../src/infra/events/domain-events.js';
import { SocialMaintenanceService } from '../../src/modules/matches/social-maintenance.service.js';
import { type Signup, type TestApp, bearer, createTestApp, del, get, post, signup } from './app-helper.js';
import { prisma, resetDb } from './helpers.js';
import { type World, confirmedBooking, createWorld, newPlayer, nextSlot } from './social-fixtures.js';
import { dayIn } from './venue-fixtures.js';

describe('sessions « Complétez votre équipe »', () => {
  let t: TestApp;
  let w: World;
  const events: { name: string; payload: unknown }[] = [];
  const seen = (name: keyof DomainEventMap) => events.filter((e) => e.name === name);

  beforeAll(async () => {
    await resetDb();
    await seedBaseline(prisma);
    t = await createTestApp();
    w = await createWorld(t);
    const bus = t.app.get(DomainEvents);
    for (const name of ['solo.player_joined', 'solo.player_left', 'solo.full', 'solo.cancelled', 'match.cancelled'] as const) {
      bus.on(name, (payload) => void events.push({ name, payload }));
    }
  });
  afterAll(() => t.close());
  beforeEach(() => {
    t.rateLimits.reset();
    events.length = 0;
  });

  // ───────────────────────── Outils ─────────────────────────

  const open = (host: Signup, bookingId: string, extra: Record<string, unknown> = {}) =>
    post(t, '/solo-sessions', { bookingId, spots: 3, ...extra }, bearer(host.accessToken));
  const join = (user: Signup, id: string) => post(t, `/solo-sessions/${id}/join`, undefined, bearer(user.accessToken));
  const leave = (user: Signup, id: string) => post(t, `/solo-sessions/${id}/leave`, undefined, bearer(user.accessToken));
  /** Session ouverte par un nouvel hôte sur une nouvelle réservation. */
  async function newSession(extra: Record<string, unknown> = {}, field: 'small' | 'large' = 'small') {
    const host = await newPlayer(t);
    const booking = await confirmedBooking(w, host, { field });
    const res = await open(host, booking.id, extra);
    if (res.statusCode !== 201) throw new Error(`Création impossible : ${res.body}`);
    return { host, booking, session: res.json() as { id: string; matchId: string } };
  }

  // ───────────────────────── Création ─────────────────────────

  describe('création par un joueur', () => {
    it('ouvre des places sur SA réservation confirmée : session, match et audit', async () => {
      const host = await newPlayer(t);
      const booking = await confirmedBooking(w, host);
      const res = await open(host, booking.id, { spots: 4, level: 'INTERMEDIATE', description: 'Foot du soir', pricePerPlayerMinor: 500 });

      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({
        status: 'OPEN',
        origin: 'PLAYER',
        spots: 4,
        joinedCount: 0,
        remaining: 4,
        level: 'INTERMEDIATE',
        pricePerPlayerMinor: 500,
        description: 'Foot du soir',
        joined: true,
        isHost: true,
        players: [],
        venue: { id: w.venue.id },
        field: { id: w.small.id, capacity: 10 },
      });
      const match = await prisma.match.findUniqueOrThrow({ where: { bookingId: booking.id }, include: { participants: true } });
      expect(match).toMatchObject({ source: 'SOLO_SESSION', status: 'SCHEDULED', soloSessionId: res.json().id });
      expect(match.participants.map((p) => p.userId)).toEqual([host.userId]);
      expect(await prisma.auditLog.count({ where: { action: 'solo.create', entityId: res.json().id } })).toBe(1);
    });

    it('exige un email vérifié et refuse les champs inconnus', async () => {
      const host = await newPlayer(t);
      const booking = await confirmedBooking(w, host);
      expect((await post(t, '/solo-sessions', { bookingId: booking.id, spots: 2 })).statusCode).toBe(401);
      const unverified = await signup(t);
      expect((await open(unverified, booking.id)).statusCode).toBe(403);
      for (const extra of [{ status: 'FULL' }, { joinedCount: 5 }, { capacity: 9 }, { createdById: host.userId }]) {
        expect((await open(host, booking.id, extra)).statusCode, JSON.stringify(extra)).toBe(400);
      }
    });

    it('limite les places : au plus (capacité du terrain − l’hôte)', async () => {
      const host = await newPlayer(t);
      const small = await confirmedBooking(w, host);
      const tooMany = await open(host, small.id, { spots: 10 });
      expect(tooMany.statusCode).toBe(400);
      expect(tooMany.json().error.code).toBe('VALIDATION_ERROR');
      expect((await open(host, small.id, { spots: 9 })).statusCode).toBe(201);

      const large = await confirmedBooking(w, host, { field: 'large' });
      expect((await open(host, large.id, { spots: 15 })).statusCode).toBe(201);
    });

    it('refuse une réservation non éligible : d’autrui, non confirmée, passée, déjà utilisée', async () => {
      const [host, other] = await Promise.all([newPlayer(t), newPlayer(t)]);

      const theirs = await confirmedBooking(w, other);
      const stolen = await open(host, theirs.id);
      expect(stolen.statusCode).toBe(404); // indiscernable d'une réservation inexistante

      const pending = await confirmedBooking(w, host, { status: 'PENDING_PAYMENT' });
      const notConfirmed = await open(host, pending.id);
      expect(notConfirmed.statusCode).toBe(409);
      expect(notConfirmed.json().error.code).toBe('BOOKING_NOT_ELIGIBLE');

      const cancelled = await confirmedBooking(w, host, { status: 'CANCELLED' });
      expect((await open(host, cancelled.id)).json().error.code).toBe('BOOKING_NOT_ELIGIBLE');

      const past = await confirmedBooking(w, host);
      await prisma.booking.update({ where: { id: past.id }, data: { startsAt: new Date(Date.now() - 7200_000), endsAt: new Date(Date.now() - 3600_000) } });
      const started = await open(host, past.id);
      expect(started.statusCode).toBe(409);
      expect(started.json().error.code).toBe('BOOKING_NOT_ELIGIBLE');

      const used = await confirmedBooking(w, host);
      expect((await open(host, used.id)).statusCode).toBe(201);
      const again = await open(host, used.id);
      expect(again.statusCode).toBe(409);
      expect(again.json().error.code).toBe('BOOKING_NOT_ELIGIBLE');

      expect((await open(host, '00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
    });

    it('deux ouvertures simultanées sur la même réservation : une seule session', async () => {
      const host = await newPlayer(t);
      const booking = await confirmedBooking(w, host);
      const results = await Promise.all(Array.from({ length: 4 }, () => open(host, booking.id)));
      expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
      expect(await prisma.soloSession.count({ where: { bookingId: booking.id } })).toBe(1);
    });
  });

  describe('création par le complexe', () => {
    it('le personnel ouvre des places sur une réservation manuelle ; l’identité du membre n’est pas exposée', async () => {
      const booking = await confirmedBooking(w, null);
      const res = await post(t, `/manage/venues/${w.venue.id}/solo-sessions`, { bookingId: booking.id, spots: 10 }, bearer(w.staff.accessToken));

      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ origin: 'VENUE', spots: 10, host: { id: w.venue.id, name: w.venue.name }, isHost: true });
      expect(res.body).not.toContain(w.staff.email);
      const match = await prisma.match.findUniqueOrThrow({ where: { bookingId: booking.id }, include: { participants: true } });
      expect(match.participants).toHaveLength(0); // personne n'occupe de place d'avance

      const anonymous = (await get(t, `/solo-sessions/${res.json().id}`)).json();
      expect(anonymous).toMatchObject({ isHost: false, joined: false, players: null });
    });

    it('un étranger au complexe ne peut ni ouvrir des places, ni deviner l’existence du complexe (404)', async () => {
      const booking = await confirmedBooking(w, null);
      const res = await post(t, `/manage/venues/${w.venue.id}/solo-sessions`, { bookingId: booking.id, spots: 4 }, bearer(w.outsider.accessToken));
      expect(res.statusCode).toBe(404);
      expect(await prisma.soloSession.count({ where: { bookingId: booking.id } })).toBe(0);
    });

    it('ne peut pas utiliser la réservation d’un AUTRE complexe', async () => {
      const other = await createWorld(t);
      const foreign = await confirmedBooking(other, null);
      const res = await post(t, `/manage/venues/${w.venue.id}/solo-sessions`, { bookingId: foreign.id, spots: 4 }, bearer(w.staff.accessToken));
      expect(res.statusCode).toBe(404);
    });
  });

  // ───────────────────────── Rejoindre ─────────────────────────

  describe('rejoindre et quitter', () => {
    it('un joueur rejoint, la session se remplit puis se ferme, quitter la rouvre', async () => {
      const { session } = await newSession({ spots: 2 });
      const [a, b, c] = await Promise.all([newPlayer(t), newPlayer(t), newPlayer(t)]);

      const first = await join(a, session.id);
      expect(first.statusCode).toBe(200);
      expect(first.json()).toMatchObject({ joinedCount: 1, remaining: 1, status: 'OPEN', joined: true, isHost: false });
      expect(first.json().players.map((p: { id: string }) => p.id)).toEqual([a.userId]);

      expect((await join(b, session.id)).json()).toMatchObject({ remaining: 0, status: 'FULL' });
      const full = await join(c, session.id);
      expect(full.statusCode).toBe(409);
      expect(full.json().error.code).toBe('SESSION_FULL');
      expect(seen('solo.full')).toHaveLength(1);

      expect((await leave(a, session.id)).statusCode).toBe(204);
      const row = await prisma.soloSession.findUniqueOrThrow({ where: { id: session.id } });
      expect(row).toMatchObject({ joinedCount: 1, status: 'OPEN' });
      expect((await join(c, session.id)).statusCode).toBe(200);

      const match = await prisma.matchParticipant.findMany({ where: { matchId: session.matchId } });
      expect(match.map((p) => p.userId).sort()).toEqual([(await prisma.soloSession.findUniqueOrThrow({ where: { id: session.id } })).createdById, b.userId, c.userId].sort());
    });

    it('CONCURRENCE : 12 joueurs pour 3 places → exactement 3 inscrits, jamais de surréservation', async () => {
      const { session } = await newSession({ spots: 3 });
      const players = await Promise.all(Array.from({ length: 12 }, () => newPlayer(t)));
      t.rateLimits.reset();

      const results = await Promise.all(players.map((p) => join(p, session.id)));
      expect(results.filter((r) => r.statusCode === 200)).toHaveLength(3);
      expect(results.filter((r) => r.statusCode === 409).every((r) => r.json().error.code === 'SESSION_FULL')).toBe(true);

      const row = await prisma.soloSession.findUniqueOrThrow({ where: { id: session.id } });
      expect(row).toMatchObject({ joinedCount: 3, status: 'FULL' });
      expect(await prisma.soloPlayer.count({ where: { sessionId: session.id, status: 'JOINED' } })).toBe(3);
      expect(await prisma.matchParticipant.count({ where: { matchId: session.matchId } })).toBe(3 + 1); // + l'hôte
    });

    it('le même joueur qui clique 5 fois EN MÊME TEMPS ne prend qu’une place', async () => {
      const { session } = await newSession({ spots: 4 });
      const player = await newPlayer(t);
      const results = await Promise.all(Array.from({ length: 5 }, () => join(player, session.id)));
      expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
      expect(results.filter((r) => r.statusCode !== 200).every((r) => r.json().error.code === 'ALREADY_JOINED')).toBe(true);
      expect((await prisma.soloSession.findUniqueOrThrow({ where: { id: session.id } })).joinedCount).toBe(1);
    });

    it('refuse : l’hôte lui-même, un second clic, un email non vérifié, une session inconnue', async () => {
      const { host, session } = await newSession();
      const hostJoin = await join(host, session.id);
      expect(hostJoin.statusCode).toBe(409);
      expect(hostJoin.json().error.code).toBe('ALREADY_JOINED');

      const player = await newPlayer(t);
      await join(player, session.id);
      expect((await join(player, session.id)).json().error.code).toBe('ALREADY_JOINED');

      expect((await join(await signup(t), session.id)).statusCode).toBe(403);
      expect((await join(player, '00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
      expect((await post(t, `/solo-sessions/${session.id}/join`)).statusCode).toBe(401);
    });

    it('applique la règle de niveau (±1) ; une session ouverte à tous accepte tout le monde', async () => {
      const { session: advanced } = await newSession({ level: 'ADVANCED' });
      const beginner = await newPlayer(t, 'BEGINNER');
      const intermediate = await newPlayer(t, 'INTERMEDIATE');
      const refused = await join(beginner, advanced.id);
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error.code).toBe('LEVEL_INCOMPATIBLE');
      expect((await join(intermediate, advanced.id)).statusCode).toBe(200);

      const { session: anyone } = await newSession();
      expect((await join(beginner, anyone.id)).statusCode).toBe(200);
    });

    it('refuse deux sessions qui se chevauchent (SCHEDULE_CONFLICT) mais autorise des créneaux distincts', async () => {
      const at = nextSlot();
      const [hostA, hostB] = await Promise.all([newPlayer(t), newPlayer(t)]);
      const bookingA = await confirmedBooking(w, hostA, { at });
      const bookingB = await confirmedBooking(w, hostB, { at, field: 'large' }); // même heure, autre terrain
      const a = (await open(hostA, bookingA.id)).json();
      const b = (await open(hostB, bookingB.id)).json();
      const player = await newPlayer(t);

      expect((await join(player, a.id)).statusCode).toBe(200);
      const clash = await join(player, b.id);
      expect(clash.statusCode).toBe(409);
      expect(clash.json().error.code).toBe('SCHEDULE_CONFLICT');

      const { session: elsewhere } = await newSession();
      expect((await join(player, elsewhere.id)).statusCode).toBe(200);
    });

    it('quitter : seulement si on participe et avant le début ; on peut ensuite revenir', async () => {
      const { session } = await newSession();
      const [player, stranger] = await Promise.all([newPlayer(t), newPlayer(t)]);
      await join(player, session.id);
      expect((await leave(stranger, session.id)).statusCode).toBe(404);

      expect((await leave(player, session.id)).statusCode).toBe(204);
      expect((await leave(player, session.id)).statusCode).toBe(404); // déjà parti
      expect(seen('solo.player_left')).toHaveLength(1);
      expect((await join(player, session.id)).statusCode).toBe(200); // revient
      expect(await prisma.soloPlayer.count({ where: { sessionId: session.id, userId: player.userId, status: 'JOINED' } })).toBe(1);

      await prisma.soloSession.update({ where: { id: session.id }, data: { startsAt: new Date(Date.now() - 60_000) } });
      const late = await leave(player, session.id);
      expect(late.statusCode).toBe(409);
      expect(late.json().error.code).toBe('SESSION_CLOSED');
    });

    it('une session commencée ou annulée n’accepte plus personne', async () => {
      const { session } = await newSession();
      const { session: cancelled, host } = await newSession();
      await del(t, `/solo-sessions/${cancelled.id}`, host.accessToken);
      const player = await newPlayer(t);
      expect((await join(player, cancelled.id)).json().error.code).toBe('SESSION_CLOSED');

      await prisma.soloSession.update({ where: { id: session.id }, data: { startsAt: new Date(Date.now() - 60_000) } });
      expect((await join(player, session.id)).json().error.code).toBe('SESSION_CLOSED');
    });
  });

  // ───────────────────────── Annulation ─────────────────────────

  describe('annulation', () => {
    it('l’hôte annule : session et match annulés, joueurs prévenus (événement), réservation conservée', async () => {
      const { host, booking, session } = await newSession();
      const [a, b] = await Promise.all([newPlayer(t), newPlayer(t)]);
      await join(a, session.id);
      await join(b, session.id);

      expect((await del(t, `/solo-sessions/${session.id}`, host.accessToken)).statusCode).toBe(204);
      expect(await prisma.soloSession.findUniqueOrThrow({ where: { id: session.id } })).toMatchObject({ status: 'CANCELLED' });
      expect((await prisma.match.findUniqueOrThrow({ where: { id: session.matchId } })).status).toBe('CANCELLED');
      expect((await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe('CONFIRMED');
      expect(seen('solo.cancelled')).toHaveLength(1);
      expect((seen('solo.cancelled')[0]!.payload as { playerIds: string[] }).playerIds.sort()).toEqual([a.userId, b.userId].sort());
      expect(await prisma.auditLog.count({ where: { action: 'solo.cancel', entityId: session.id } })).toBe(1);

      // Idempotent : une seconde annulation est refusée proprement
      expect((await del(t, `/solo-sessions/${session.id}`, host.accessToken)).statusCode).toBe(409);
      expect(seen('solo.cancelled')).toHaveLength(1);
    });

    it('un joueur inscrit ou un étranger ne peut pas annuler (404) ; le personnel du complexe le peut', async () => {
      const { session } = await newSession();
      const player = await newPlayer(t);
      await join(player, session.id);
      expect((await del(t, `/solo-sessions/${session.id}`, player.accessToken)).statusCode).toBe(404);
      expect((await del(t, `/solo-sessions/${session.id}`, w.outsider.accessToken)).statusCode).toBe(404);
      expect((await prisma.soloSession.findUniqueOrThrow({ where: { id: session.id } })).status).toBe('OPEN');

      expect((await del(t, `/solo-sessions/${session.id}`, w.staff.accessToken)).statusCode).toBe(204);
      const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'solo.cancel', entityId: session.id } });
      expect(audit.actorRole).toBe('STAFF');
    });

    it('l’annulation de la RÉSERVATION arrête la session et son match (cascade)', async () => {
      const { host, booking, session } = await newSession();
      const player = await newPlayer(t);
      await join(player, session.id);

      const cancel = await post(t, `/bookings/${booking.id}/cancel`, {}, bearer(host.accessToken));
      expect(cancel.statusCode).toBe(200);

      expect((await prisma.soloSession.findUniqueOrThrow({ where: { id: session.id } })).status).toBe('CANCELLED');
      expect((await prisma.match.findUniqueOrThrow({ where: { id: session.matchId } })).status).toBe('CANCELLED');
      expect((seen('solo.cancelled')[0]!.payload as { playerIds: string[] }).playerIds).toEqual([player.userId]);
    });

    it('la maintenance rattrape une réservation annulée dont l’événement s’est perdu', async () => {
      const { booking, session } = await newSession();
      await prisma.booking.update({ where: { id: booking.id }, data: { status: 'CANCELLED', cancelledAt: new Date() } });

      const result = await t.app.get(SocialMaintenanceService).runOnce();
      expect(result.cascaded).toBeGreaterThanOrEqual(1);
      expect((await prisma.soloSession.findUniqueOrThrow({ where: { id: session.id } })).status).toBe('CANCELLED');
      // Rejouée : plus rien à faire
      expect((await t.app.get(SocialMaintenanceService).runOnce()).cascaded).toBe(0);
    });
  });

  // ───────────────────────── Consultation ─────────────────────────

  describe('consultation', () => {
    it('la liste est publique, masque la liste des joueurs et abrège le nom de l’hôte', async () => {
      const { host, session } = await newSession();
      const player = await newPlayer(t);
      await join(player, session.id);

      const anonymous = (await get(t, `/solo-sessions?venue=${w.venue.slug}`)).json();
      const item = anonymous.items.find((s: { id: string }) => s.id === session.id);
      expect(item).toMatchObject({ players: null, joined: false, isHost: false, joinedCount: 1 });
      expect(item.host.name).toMatch(/^\S+ \S\.$/);
      expect(anonymous.items.every((s: { status: string }) => s.status === 'OPEN')).toBe(true);

      const logged = (await get(t, `/solo-sessions?venue=${w.venue.slug}`, player.accessToken)).json();
      const own = logged.items.find((s: { id: string }) => s.id === session.id);
      expect(own).toMatchObject({ joined: true });
      expect(own.players).toHaveLength(1);
      expect(own.host.name).toContain(' ');
      expect(host.userId).toBeDefined();
    });

    it('filtre par ville, complexe, date, heure (± fenêtre), niveau, places libres', async () => {
      const w2 = await createWorld(t, { city: 'Oran' });
      const at = { date: dayIn(40), hhmm: '19:00' };
      const host = await newPlayer(t);
      const inOran = (await open(host, (await confirmedBooking(w2, host, { at })).id, { spots: 2, level: 'ADVANCED' })).json();
      const host2 = await newPlayer(t);
      const sameDay = (await open(host2, (await confirmedBooking(w2, host2, { at: { date: at.date, hhmm: '22:00' } })).id, { spots: 5 })).json();

      const ids = async (qs: string) => (await get(t, `/solo-sessions?${qs}`)).json().items.map((s: { id: string }) => s.id);
      expect(await ids(`city=oran&date=${at.date}`)).toEqual([inOran.id, sameDay.id]);
      expect(await ids(`venue=${w2.venue.slug}&date=${at.date}&time=19:00`)).toEqual([inOran.id]); // heure exacte
      expect(await ids(`venue=${w2.venue.slug}&date=${at.date}&time=20:00&window=120`)).toEqual([inOran.id, sameDay.id]);
      expect(await ids(`venue=${w2.venue.slug}&date=${at.date}&time=20:00&window=60`)).toEqual([inOran.id]);
      expect(await ids(`city=oran&date=${at.date}&spots=4`)).toEqual([sameDay.id]);
      expect(await ids(`city=oran&date=${at.date}&level=BEGINNER`)).toEqual([sameDay.id]); // ADVANCED exclu, « ouvert » inclus
      expect(await ids(`city=oran&date=${dayIn(41)}`)).toEqual([]);
      expect(await ids(`city=nulle-part`)).toEqual([]);
      expect((await get(t, `/solo-sessions?time=19:00`)).statusCode).toBe(400); // l'heure exige la date
    });

    it('trie : plus proches d’être complètes d’abord (spots) ; recommandées = niveau et ville du joueur', async () => {
      const w2 = await createWorld(t, { city: 'Constantine' });
      const mk = async (spots: number, hhmm: string, level?: string) => {
        const h = await newPlayer(t);
        return (await open(h, (await confirmedBooking(w2, h, { at: { date: dayIn(45), hhmm } })).id, { spots, ...(level ? { level } : {}) })).json();
      };
      const wide = await mk(6, '12:00');
      const almost = await mk(2, '14:00');
      const pro = await mk(4, '13:00', 'ADVANCED');

      const bySpots = (await get(t, `/solo-sessions?city=constantine&sort=spots`)).json().items.map((s: { id: string }) => s.id);
      expect(bySpots).toEqual([almost.id, pro.id, wide.id]);

      const beginner = await newPlayer(t, 'BEGINNER');
      const recommended = (await get(t, `/solo-sessions?city=constantine&sort=recommended`, beginner.accessToken)).json().items.map((s: { id: string }) => s.id);
      expect(recommended).not.toContain(pro.id); // ADVANCED incompatible avec un débutant : jamais proposée
      expect(recommended[0]).toBe(almost.id); // presque complète → en tête
    });

    it('pagine sans doublon ni oubli', async () => {
      const w2 = await createWorld(t, { city: 'Annaba' });
      for (let i = 0; i < 5; i++) {
        const h = await newPlayer(t);
        await open(h, (await confirmedBooking(w2, h, { at: { date: dayIn(50), hhmm: `${11 + i}:00` } })).id);
      }
      const seenIds: string[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 5; guard++) {
        const page: { items: { id: string }[]; nextCursor: string | null } = (await get(t, `/solo-sessions?city=annaba&limit=2${cursor ? `&cursor=${cursor}` : ''}`)).json();
        seenIds.push(...page.items.map((s) => s.id));
        cursor = page.nextCursor;
        if (!cursor) break;
      }
      expect(seenIds).toHaveLength(5);
      expect(new Set(seenIds).size).toBe(5);
    });

    it('un complexe non approuvé n’apparaît pas', async () => {
      const w2 = await createWorld(t, { city: 'Sétif' });
      const h = await newPlayer(t);
      const s = (await open(h, (await confirmedBooking(w2, h)).id)).json();
      await prisma.venue.update({ where: { id: w2.venue.id }, data: { status: 'SUSPENDED' } });
      expect((await get(t, `/solo-sessions?city=sétif`)).json().items).toEqual([]);
      expect((await get(t, `/solo-sessions/${s.id}`)).statusCode).toBe(404);
      expect((await join(await newPlayer(t), s.id)).statusCode).toBe(404);
    });

    it('le détail d’une session fermée n’est visible que des personnes concernées', async () => {
      const { host, session } = await newSession();
      const player = await newPlayer(t);
      await join(player, session.id);
      await del(t, `/solo-sessions/${session.id}`, host.accessToken);

      expect((await get(t, `/solo-sessions/${session.id}`)).statusCode).toBe(404);
      expect((await get(t, `/solo-sessions/${session.id}`, (await newPlayer(t)).accessToken)).statusCode).toBe(404);
      expect((await get(t, `/solo-sessions/${session.id}`, host.accessToken)).json().status).toBe('CANCELLED');
      expect((await get(t, `/solo-sessions/${session.id}`, player.accessToken)).statusCode).toBe(200);
      expect((await get(t, `/solo-sessions/${session.id}`, w.staff.accessToken)).statusCode).toBe(200);
      expect((await get(t, '/solo-sessions/pas-un-uuid')).statusCode).toBe(400);
    });

    it('GET /me/solo-sessions : celles que j’organise et celles que j’ai rejointes', async () => {
      const { host, session: mine } = await newSession();
      const { session: joined } = await newSession();
      await join(host, joined.id);
      const { session: unrelated } = await newSession();

      const ids = (await get(t, '/me/solo-sessions', host.accessToken)).json().items.map((s: { id: string }) => s.id);
      expect(ids).toContain(mine.id);
      expect(ids).toContain(joined.id);
      expect(ids).not.toContain(unrelated.id);
      expect((await get(t, '/me/solo-sessions?when=past', host.accessToken)).json().items).toEqual([]);
      expect((await get(t, '/me/solo-sessions')).statusCode).toBe(401);
    });
  });

  // ───────────────────────── Fin de match ─────────────────────────

  it('quand le créneau est passé : session et match terminés, statistiques créditées une seule fois', async () => {
    const { host, booking, session } = await newSession({ spots: 2 });
    const [a, b] = await Promise.all([newPlayer(t), newPlayer(t)]);
    await join(a, session.id);
    await join(b, session.id);

    const after = new Date(booking.endsAt.getTime() + 60_000);
    const maintenance = t.app.get(SocialMaintenanceService);
    expect((await maintenance.runOnce(after)).completedMatches).toBeGreaterThanOrEqual(1);
    expect((await maintenance.runOnce(after)).completedMatches).toBe(0); // rejouée : rien de plus

    expect((await prisma.soloSession.findUniqueOrThrow({ where: { id: session.id } })).status).toBe('COMPLETED');
    expect((await prisma.match.findUniqueOrThrow({ where: { id: session.matchId } })).status).toBe('COMPLETED');
    const stats = async (u: Signup) => (await prisma.playerStats.findUnique({ where: { userId: u.userId } }))?.matchesPlayed ?? 0;
    expect(await stats(a)).toBe(1);
    expect(await stats(b)).toBe(1);
    expect(await stats(host)).toBe(0); // l'hôte est compté par la maintenance des réservations
  });
});
