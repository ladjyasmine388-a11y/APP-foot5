import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedBaseline } from '../../src/infra/database/baseline.js';
import { DomainEvents, type DomainEventMap } from '../../src/infra/events/domain-events.js';
import { SocialMaintenanceService } from '../../src/modules/matches/social-maintenance.service.js';
import {
  type Signup,
  type TestApp,
  bearer,
  createTestApp,
  del,
  get,
  post,
  put,
} from './app-helper.js';
import { prisma, resetDb } from './helpers.js';
import {
  type World,
  confirmedBooking,
  createWorld,
  makeTeam,
  newPlayer,
} from './social-fixtures.js';
import { dayIn } from './venue-fixtures.js';

type Team = Awaited<ReturnType<typeof makeTeam>>;

describe('adversaires et matchs', () => {
  let t: TestApp;
  let w: World;
  let capA: Signup, capB: Signup, capC: Signup, capD: Signup;
  let teamA: Team, teamB: Team, teamC: Team, tiny: Team;
  const events: { name: string; payload: unknown }[] = [];
  const seen = (name: keyof DomainEventMap) => events.filter((e) => e.name === name);

  beforeAll(async () => {
    await resetDb();
    await seedBaseline(prisma);
    t = await createTestApp();
    w = await createWorld(t);
    [capA, capB, capC, capD] = await Promise.all([
      newPlayer(t),
      newPlayer(t),
      newPlayer(t),
      newPlayer(t),
    ]);
    teamA = await makeTeam(t, capA, 6);
    teamB = await makeTeam(t, capB, 6);
    teamC = await makeTeam(t, capC, 6);
    tiny = await makeTeam(t, capD, 3);
    // Un membre simple dont l'email est vérifié : pour tester « non-capitaine » sur les routes qui exigent un email vérifié.
    await prisma.user.updateMany({
      where: { id: { in: [teamA.members[0]!.userId, teamC.members[0]!.userId] } },
      data: { emailVerifiedAt: new Date() },
    });
    const bus = t.app.get(DomainEvents);
    for (const name of [
      'opponent.request_created',
      'opponent.request_accepted',
      'opponent.request_rejected',
      'match.cancelled',
    ] as const) {
      bus.on(name, (payload) => void events.push({ name, payload }));
    }
  });
  afterAll(() => t.close());
  beforeEach(() => {
    t.rateLimits.reset();
    events.length = 0;
  });

  // ───────────────────────── Outils ─────────────────────────

  const listingBody = (teamId: string, bookingId: string, extra: Record<string, unknown> = {}) => ({
    teamId,
    bookingId,
    ...extra,
  });
  const publish = (
    cap: Signup,
    teamId: string,
    bookingId: string,
    extra: Record<string, unknown> = {},
  ) =>
    post(t, '/opponent-listings', listingBody(teamId, bookingId, extra), bearer(cap.accessToken));
  const request = (cap: Signup, listingId: string, teamId: string, message?: string) =>
    post(
      t,
      `/opponent-listings/${listingId}/requests`,
      { teamId, ...(message ? { message } : {}) },
      bearer(cap.accessToken),
    );
  const accept = (cap: Signup, listingId: string, requestId: string) =>
    post(
      t,
      `/opponent-listings/${listingId}/requests/${requestId}/accept`,
      undefined,
      bearer(cap.accessToken),
    );

  /** Annonce de teamA sur une nouvelle réservation de capA. */
  async function newListing(
    extra: Record<string, unknown> = {},
    field: 'small' | 'large' = 'small',
  ) {
    const booking = await confirmedBooking(w, capA, { field });
    const res = await publish(capA, teamA.id, booking.id, extra);
    if (res.statusCode !== 201) throw new Error(`Annonce impossible : ${res.body}`);
    return { booking, listing: res.json() as { id: string } };
  }
  /** Annonce + demande de teamB acceptée → match. */
  async function newMatch() {
    const { booking, listing } = await newListing();
    const req = (await request(capB, listing.id, teamB.id)).json() as { id: string };
    const match = (await accept(capA, listing.id, req.id)).json() as { id: string };
    return { booking, listing, req, match };
  }

  // ───────────────────────── Annonces ─────────────────────────

  describe('publier une annonce', () => {
    it('le capitaine annonce SA réservation : format par défaut, niveau de l’équipe, audit', async () => {
      const small = await confirmedBooking(w, capA);
      const res = await publish(capA, teamA.id, small.id, { comment: 'Match amical jeudi' });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({
        status: 'OPEN',
        playersPerSide: 5,
        level: 'BEGINNER',
        comment: 'Match amical jeudi',
        team: { id: teamA.id, name: teamA.name, memberCount: 6 },
        field: { capacity: 10 },
        pendingRequests: 0,
        myRequest: null,
        matchId: null,
      });
      expect(
        await prisma.auditLog.count({
          where: { action: 'opponent.listing_create', entityId: res.json().id },
        }),
      ).toBe(1);

      const large = await confirmedBooking(w, capA, { field: 'large' });
      expect((await publish(capA, teamA.id, large.id)).json().playersPerSide).toBe(6); // effectif de 6 : format 6 contre 6
    });

    it('refuse une équipe trop petite pour le format (TEAM_TOO_SMALL) et un format trop grand pour le terrain', async () => {
      const bookingD = await confirmedBooking(w, capD);
      const small = await publish(capD, tiny.id, bookingD.id);
      expect(small.statusCode).toBe(409);
      expect(small.json().error.code).toBe('TEAM_TOO_SMALL');

      const bookingA = await confirmedBooking(w, capA);
      const tooBig = await publish(capA, teamA.id, bookingA.id, { playersPerSide: 6 }); // 12 joueurs sur un terrain de 10
      expect(tooBig.statusCode).toBe(400);
      expect((await publish(capA, teamA.id, bookingA.id, { playersPerSide: 4 })).statusCode).toBe(
        400,
      ); // schéma : 5 à 8
    });

    it('seul le capitaine de l’équipe, avec SA réservation confirmée et à venir', async () => {
      const own = await confirmedBooking(w, capA);
      const member = teamA.members[0]!;
      const notCaptain = await publish(member, teamA.id, own.id);
      expect(notCaptain.statusCode).toBe(403);
      expect(notCaptain.json().error.code).toBe('NOT_CAPTAIN');
      expect((await publish(capB, teamA.id, own.id)).statusCode).toBe(403); // capitaine d'une AUTRE équipe

      const foreign = await confirmedBooking(w, capB);
      expect((await publish(capA, teamA.id, foreign.id)).statusCode).toBe(404);
      const pending = await confirmedBooking(w, capA, { status: 'PENDING_PAYMENT' });
      expect((await publish(capA, teamA.id, pending.id)).json().error.code).toBe(
        'BOOKING_NOT_ELIGIBLE',
      );
      expect((await publish(capA, teamA.id, own.id, { status: 'ACCEPTED' })).statusCode).toBe(400);
      expect((await post(t, '/opponent-listings', listingBody(teamA.id, own.id))).statusCode).toBe(
        401,
      );
    });

    it('une réservation ne porte qu’une activité : annonce, session ou match', async () => {
      const booking = await confirmedBooking(w, capA);
      expect((await publish(capA, teamA.id, booking.id)).statusCode).toBe(201);
      expect((await publish(capA, teamA.id, booking.id)).json().error.code).toBe(
        'BOOKING_NOT_ELIGIBLE',
      );
      const solo = await post(
        t,
        '/solo-sessions',
        { bookingId: booking.id, spots: 2 },
        bearer(capA.accessToken),
      );
      expect(solo.json().error.code).toBe('BOOKING_NOT_ELIGIBLE');
      const asMatch = await post(
        t,
        '/matches',
        { teamId: teamA.id, bookingId: booking.id },
        bearer(capA.accessToken),
      );
      expect(asMatch.json().error.code).toBe('BOOKING_NOT_ELIGIBLE');
    });

    it('deux publications simultanées sur la même réservation : une seule annonce', async () => {
      const booking = await confirmedBooking(w, capA);
      const results = await Promise.all(
        Array.from({ length: 4 }, () => publish(capA, teamA.id, booking.id)),
      );
      expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
      expect(await prisma.opponentListing.count({ where: { bookingId: booking.id } })).toBe(1);
    });
  });

  describe('consulter les annonces', () => {
    it('liste publique filtrée, sans données sensibles ; drapeaux « ma demande » et « demandes reçues » selon le visiteur', async () => {
      const w2 = await createWorld(t, { city: 'Tlemcen' });
      const at = { date: dayIn(60), hhmm: '19:00' };
      const owner = capA;
      const bookingSmall = await confirmedBooking(w2, owner, { at });
      const bookingLarge = await confirmedBooking(w2, owner, {
        at: { date: at.date, hhmm: '21:00' },
        field: 'large',
      });
      const small = (await publish(capA, teamA.id, bookingSmall.id)).json();
      const large = (await publish(capA, teamA.id, bookingLarge.id, { playersPerSide: 6 })).json();
      await request(capB, small.id, teamB.id);

      const ids = async (qs: string, token?: string) =>
        (await get(t, `/opponent-listings?${qs}`, token))
          .json()
          .items.map((i: { id: string }) => i.id);
      expect(await ids('city=tlemcen')).toEqual([small.id, large.id]);
      expect(await ids('city=tlemcen&playersPerSide=6')).toEqual([large.id]);
      expect(await ids(`venue=${w2.venue.slug}&date=${at.date}`)).toEqual([small.id, large.id]);
      expect(await ids('city=tlemcen&level=ADVANCED')).toEqual([]);
      expect(await ids(`city=tlemcen&date=${dayIn(61)}`)).toEqual([]);

      const anonymous = (await get(t, '/opponent-listings?city=tlemcen')).json().items[0];
      expect(anonymous).toMatchObject({ pendingRequests: null, myRequest: null });
      expect(JSON.stringify(anonymous)).not.toMatch(/email|phone|@/);

      const asHost = (await get(t, '/opponent-listings?city=tlemcen', capA.accessToken)).json()
        .items[0];
      expect(asHost.pendingRequests).toBe(1);
      const asRequester = (await get(t, '/opponent-listings?city=tlemcen', capB.accessToken)).json()
        .items[0];
      expect(asRequester).toMatchObject({
        pendingRequests: null,
        myRequest: { status: 'REQUESTED', teamId: teamB.id },
      });
    });

    it('une annonce fermée disparaît de la liste et n’est visible que des équipes concernées', async () => {
      const { listing } = await newListing();
      const req = (await request(capB, listing.id, teamB.id)).json();
      await accept(capA, listing.id, req.id);

      expect((await get(t, `/opponent-listings/${listing.id}`)).statusCode).toBe(404);
      expect(
        (await get(t, `/opponent-listings/${listing.id}`, (await newPlayer(t)).accessToken))
          .statusCode,
      ).toBe(404);
      expect(
        (await get(t, `/opponent-listings/${listing.id}`, capA.accessToken)).json().status,
      ).toBe('ACCEPTED');
      expect((await get(t, `/opponent-listings/${listing.id}`, capB.accessToken)).statusCode).toBe(
        200,
      );
      expect(
        (await get(t, `/opponent-listings/${listing.id}`, w.staff.accessToken)).statusCode,
      ).toBe(200);
      const open = (await get(t, `/opponent-listings?venue=${w.venue.slug}&limit=50`))
        .json()
        .items.map((i: { id: string }) => i.id);
      expect(open).not.toContain(listing.id);
    });

    it('GET /me/opponent-listings et /me/opponent-requests', async () => {
      const { listing } = await newListing();
      await request(capB, listing.id, teamB.id);
      expect(
        (await get(t, '/me/opponent-listings', capA.accessToken))
          .json()
          .map((l: { id: string }) => l.id),
      ).toContain(listing.id);
      const member = teamA.members[0]!;
      expect(
        (await get(t, '/me/opponent-listings', member.accessToken))
          .json()
          .map((l: { id: string }) => l.id),
      ).toContain(listing.id);
      expect(
        (await get(t, '/me/opponent-requests', capB.accessToken))
          .json()
          .map((r: { listingId: string }) => r.listingId),
      ).toContain(listing.id);
      expect(
        (await get(t, '/me/opponent-requests', capA.accessToken))
          .json()
          .map((r: { listingId: string }) => r.listingId),
      ).not.toContain(listing.id);
    });
  });

  // ───────────────────────── Demandes ─────────────────────────

  describe('demander à jouer', () => {
    it('le capitaine d’une autre équipe demande ; le message est conservé ; le capitaine annonceur voit la demande', async () => {
      const { listing } = await newListing();
      const res = await request(capB, listing.id, teamB.id, 'On est dispo !');
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({
        status: 'REQUESTED',
        listingId: listing.id,
        message: 'On est dispo !',
        team: { id: teamB.id, memberCount: 6 },
      });
      expect(seen('opponent.request_created')).toHaveLength(1);

      const received = (
        await get(t, `/opponent-listings/${listing.id}/requests`, capA.accessToken)
      ).json();
      expect(received).toHaveLength(1);
      expect(
        (await get(t, `/opponent-listings/${listing.id}/requests`, capB.accessToken)).statusCode,
      ).toBe(403);
      expect(
        (
          await get(
            t,
            `/opponent-listings/${listing.id}/requests`,
            (await newPlayer(t)).accessToken,
          )
        ).statusCode,
      ).toBe(403);
    });

    it('refuse : sa propre équipe, un double envoi, une équipe trop petite, un niveau trop éloigné, un non-capitaine', async () => {
      const { listing } = await newListing();
      expect((await request(capA, listing.id, teamA.id)).json().error.code).toBe('CONFLICT');

      const second = await makeTeam(t, capA, 5, { name: `Seconde équipe ${Date.now()}` });
      const bothSides = await request(capA, listing.id, second.id);
      expect(bothSides.statusCode).toBe(409); // un capitaine ne joue pas des deux côtés

      expect((await request(capB, listing.id, teamB.id)).statusCode).toBe(201);
      expect((await request(capB, listing.id, teamB.id)).json().error.code).toBe('CONFLICT');

      expect((await request(capD, listing.id, tiny.id)).json().error.code).toBe('TEAM_TOO_SMALL');

      const expert = await newPlayer(t);
      const advanced = await makeTeam(t, expert, 6, { level: 'ADVANCED' });
      expect((await request(expert, listing.id, advanced.id)).json().error.code).toBe(
        'LEVEL_INCOMPATIBLE',
      );

      const notCaptain = await request(teamC.members[0]!, listing.id, teamC.id);
      expect(notCaptain.statusCode).toBe(403);
      expect(notCaptain.json().error.code).toBe('NOT_CAPTAIN');
      expect((await request(capC, listing.id, teamB.id)).statusCode).toBe(403); // équipe qui n'est pas la sienne
    });

    it('refuse si l’équipe a déjà un match sur ce créneau (SCHEDULE_CONFLICT)', async () => {
      const { booking } = await newListing();
      const other = await confirmedBooking(w, capB, {
        field: 'large',
        at: { date: dayIn(3), hhmm: '12:00' },
      });
      await prisma.booking.update({
        where: { id: other.id },
        data: { startsAt: booking.startsAt, endsAt: booking.endsAt },
      });
      const busy = await post(
        t,
        '/matches',
        { teamId: teamB.id, bookingId: other.id },
        bearer(capB.accessToken),
      );
      expect(busy.statusCode).toBe(201);

      const listing = (
        await prisma.opponentListing.findUniqueOrThrow({ where: { bookingId: booking.id } })
      ).id;
      const res = await request(capB, listing, teamB.id);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('SCHEDULE_CONFLICT');
    });

    it('refuse une annonce fermée, expirée ou inconnue', async () => {
      const { listing } = await newListing();
      await del(t, `/opponent-listings/${listing.id}`, capA.accessToken);
      expect((await request(capB, listing.id, teamB.id)).json().error.code).toBe('SESSION_CLOSED');
      expect(
        (await request(capB, '00000000-0000-4000-8000-000000000000', teamB.id)).statusCode,
      ).toBe(404);
    });

    it('refuser puis retirer une demande ; après un refus l’équipe peut redemander', async () => {
      const { listing } = await newListing();
      const req = (await request(capB, listing.id, teamB.id)).json();
      expect(
        (
          await post(
            t,
            `/opponent-listings/${listing.id}/requests/${req.id}/reject`,
            undefined,
            bearer(capB.accessToken),
          )
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await post(
            t,
            `/opponent-listings/${listing.id}/requests/${req.id}/reject`,
            undefined,
            bearer(capA.accessToken),
          )
        ).statusCode,
      ).toBe(204);
      expect(seen('opponent.request_rejected')).toHaveLength(1);
      expect(
        (
          await post(
            t,
            `/opponent-listings/${listing.id}/requests/${req.id}/reject`,
            undefined,
            bearer(capA.accessToken),
          )
        ).statusCode,
      ).toBe(404); // déjà traitée

      const again = (await request(capB, listing.id, teamB.id)).json();
      expect(again.status).toBe('REQUESTED');
      expect((await del(t, `/opponent-requests/${again.id}`, capA.accessToken)).statusCode).toBe(
        403,
      );
      expect((await del(t, `/opponent-requests/${again.id}`, capB.accessToken)).statusCode).toBe(
        204,
      );
      expect((await del(t, `/opponent-requests/${again.id}`, capB.accessToken)).statusCode).toBe(
        409,
      );
    });
  });

  // ───────────────────────── Acceptation ─────────────────────────

  describe('accepter une demande', () => {
    it('crée le match avec les deux effectifs, rejette les autres demandes, ferme l’annonce', async () => {
      const { booking, listing } = await newListing();
      const reqB = (await request(capB, listing.id, teamB.id)).json();
      const reqC = (await request(capC, listing.id, teamC.id)).json();

      const res = await accept(capA, listing.id, reqB.id);
      expect(res.statusCode).toBe(200);
      const match = res.json();
      expect(match).toMatchObject({
        source: 'OPPONENT_LISTING',
        status: 'SCHEDULED',
        teamA: { id: teamA.id },
        teamB: { id: teamB.id },
        playersPerSide: 5,
        opponentListingId: listing.id,
        bookingId: booking.id,
        scoreA: null,
      });
      expect(match.participants).toHaveLength(12);
      expect(match.participants.filter((p: { side: string }) => p.side === 'A')).toHaveLength(6);
      expect(match.participants.filter((p: { side: string }) => p.side === 'B')).toHaveLength(6);

      expect(
        (await prisma.opponentListing.findUniqueOrThrow({ where: { id: listing.id } })).status,
      ).toBe('ACCEPTED');
      const statuses = await prisma.matchRequest.findMany({
        where: { listingId: listing.id },
        orderBy: { createdAt: 'asc' },
      });
      expect(statuses.map((r) => [r.id, r.status])).toEqual([
        [reqB.id, 'ACCEPTED'],
        [reqC.id, 'REJECTED'],
      ]);
      expect(seen('opponent.request_accepted')).toHaveLength(1);
      expect(seen('opponent.request_rejected')).toHaveLength(1);
      expect(
        await prisma.auditLog.count({
          where: { action: 'opponent.request_accept', entityId: listing.id },
        }),
      ).toBe(1);
    });

    it('CONCURRENCE : deux acceptations simultanées → un seul adversaire, un seul match', async () => {
      const { listing } = await newListing();
      const reqB = (await request(capB, listing.id, teamB.id)).json();
      const reqC = (await request(capC, listing.id, teamC.id)).json();

      const results = await Promise.all([
        accept(capA, listing.id, reqB.id),
        accept(capA, listing.id, reqC.id),
        accept(capA, listing.id, reqB.id),
      ]);
      expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
      expect(await prisma.match.count({ where: { opponentListingId: listing.id } })).toBe(1);
      expect(
        await prisma.matchRequest.count({ where: { listingId: listing.id, status: 'ACCEPTED' } }),
      ).toBe(1);
    });

    it('seul le capitaine annonceur accepte ; une demande d’une autre annonce est introuvable', async () => {
      const { listing } = await newListing();
      const { listing: other } = await newListing();
      const reqB = (await request(capB, listing.id, teamB.id)).json();

      expect((await accept(capB, listing.id, reqB.id)).statusCode).toBe(403); // le demandeur ne s'accepte pas lui-même
      expect((await accept(teamA.members[0]!, listing.id, reqB.id)).json().error.code).toBe(
        'NOT_CAPTAIN',
      );
      expect((await accept(capA, other.id, reqB.id)).statusCode).toBe(404);
      expect(
        (await prisma.opponentListing.findUniqueOrThrow({ where: { id: listing.id } })).status,
      ).toBe('OPEN');
    });

    it('refuse si l’équipe adverse a perdu des joueurs ou n’est plus libre entre-temps', async () => {
      const { listing } = await newListing();
      const squad = await newPlayer(t);
      const shrinking = await makeTeam(t, squad, 5);
      const req = (await request(squad, listing.id, shrinking.id)).json();
      await prisma.teamMember.updateMany({
        where: { teamId: shrinking.id, role: 'MEMBER' },
        data: { leftAt: new Date() },
      });
      const res = await accept(capA, listing.id, req.id);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('TEAM_TOO_SMALL');
    });

    it('l’annulation de la RÉSERVATION arrête annonce, demande et match (cascade)', async () => {
      const { booking, listing, match } = await newMatch();
      const cancel = await post(t, `/bookings/${booking.id}/cancel`, {}, bearer(capA.accessToken));
      expect(cancel.statusCode).toBe(200);

      expect(
        (await prisma.opponentListing.findUniqueOrThrow({ where: { id: listing.id } })).status,
      ).toBe('CANCELLED');
      expect((await prisma.match.findUniqueOrThrow({ where: { id: match.id } })).status).toBe(
        'CANCELLED',
      );
      expect(
        await prisma.matchRequest.count({ where: { listingId: listing.id, status: 'CANCELLED' } }),
      ).toBe(1);
      expect(seen('match.cancelled')).toHaveLength(1);
      expect(
        (seen('match.cancelled')[0]!.payload as { participantIds: string[] }).participantIds,
      ).toHaveLength(12);
    });
  });

  describe('retirer une annonce', () => {
    it('le capitaine retire une annonce ouverte : demandes en attente rejetées ; acceptée → annuler le match', async () => {
      const { listing } = await newListing();
      await request(capB, listing.id, teamB.id);
      await request(capC, listing.id, teamC.id);

      expect((await del(t, `/opponent-listings/${listing.id}`, capB.accessToken)).statusCode).toBe(
        403,
      );
      expect((await del(t, `/opponent-listings/${listing.id}`, capA.accessToken)).statusCode).toBe(
        204,
      );
      expect(
        (await prisma.opponentListing.findUniqueOrThrow({ where: { id: listing.id } })).status,
      ).toBe('CANCELLED');
      expect(
        await prisma.matchRequest.count({ where: { listingId: listing.id, status: 'REJECTED' } }),
      ).toBe(2);
      expect((await del(t, `/opponent-listings/${listing.id}`, capA.accessToken)).statusCode).toBe(
        409,
      );

      const { listing: accepted } = await newMatch();
      const res = await del(t, `/opponent-listings/${accepted.id}`, capA.accessToken);
      expect(res.statusCode).toBe(409);
    });

    it('la dissolution d’une équipe est refusée tant qu’une annonce est ouverte', async () => {
      const cap = await newPlayer(t);
      const solo = await makeTeam(t, cap, 5);
      const booking = await confirmedBooking(w, cap);
      const listing = (await publish(cap, solo.id, booking.id)).json();
      expect((await del(t, `/teams/${solo.id}`, cap.accessToken)).statusCode).toBe(409);
      await del(t, `/opponent-listings/${listing.id}`, cap.accessToken);
      expect((await del(t, `/teams/${solo.id}`, cap.accessToken)).statusCode).toBe(204);
    });
  });

  // ───────────────────────── Matchs ─────────────────────────

  describe('matchs', () => {
    it('match d’équipe sur sa réservation : effectif inscrit, accès réservé aux concernés', async () => {
      const booking = await confirmedBooking(w, capA);
      const res = await post(
        t,
        '/matches',
        { teamId: teamA.id, bookingId: booking.id },
        bearer(capA.accessToken),
      );
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({
        source: 'TEAM',
        status: 'SCHEDULED',
        teamA: { id: teamA.id },
        teamB: null,
        bookingId: booking.id,
      });
      expect(res.json().participants).toHaveLength(6);
      const id = res.json().id;

      expect((await get(t, `/matches/${id}`, teamA.members[1]!.accessToken)).statusCode).toBe(200);
      expect((await get(t, `/matches/${id}`, w.staff.accessToken)).statusCode).toBe(200); // personnel du complexe
      expect((await get(t, `/matches/${id}`, capB.accessToken)).statusCode).toBe(404);
      expect((await get(t, `/matches/${id}`)).statusCode).toBe(401);
      expect((await get(t, '/matches/pas-un-uuid', capA.accessToken)).statusCode).toBe(400);

      const mine = (await get(t, '/me/matches', teamA.members[2]!.accessToken))
        .json()
        .items.map((m: { id: string }) => m.id);
      expect(mine).toContain(id);
      expect(
        (await get(t, '/me/matches?when=past', capA.accessToken))
          .json()
          .items.map((m: { id: string }) => m.id),
      ).not.toContain(id);
      expect(
        (await get(t, '/me/matches', capB.accessToken))
          .json()
          .items.map((m: { id: string }) => m.id),
      ).not.toContain(id);
    });

    it('refuse : non-capitaine, réservation d’autrui, équipe inconnue', async () => {
      const booking = await confirmedBooking(w, capA);
      const member = await post(
        t,
        '/matches',
        { teamId: teamA.id, bookingId: booking.id },
        bearer(teamA.members[0]!.accessToken),
      );
      expect(member.statusCode).toBe(403);
      const foreign = await confirmedBooking(w, capB);
      expect(
        (
          await post(
            t,
            '/matches',
            { teamId: teamA.id, bookingId: foreign.id },
            bearer(capA.accessToken),
          )
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await post(
            t,
            '/matches',
            { teamId: '00000000-0000-4000-8000-000000000000', bookingId: booking.id },
            bearer(capA.accessToken),
          )
        ).statusCode,
      ).toBe(404);
    });

    it('le capitaine annule un match d’équipe à venir ; les membres ne le peuvent pas', async () => {
      const booking = await confirmedBooking(w, capA);
      const id = (
        await post(
          t,
          '/matches',
          { teamId: teamA.id, bookingId: booking.id },
          bearer(capA.accessToken),
        )
      ).json().id;
      expect(
        (await post(t, `/matches/${id}/cancel`, undefined, bearer(teamA.members[0]!.accessToken)))
          .statusCode,
      ).toBe(403);
      expect(
        (await post(t, `/matches/${id}/cancel`, undefined, bearer(capA.accessToken))).statusCode,
      ).toBe(204);
      expect((await prisma.match.findUniqueOrThrow({ where: { id } })).status).toBe('CANCELLED');
      expect(
        (await post(t, `/matches/${id}/cancel`, undefined, bearer(capA.accessToken))).statusCode,
      ).toBe(409);
      expect(seen('match.cancelled')).toHaveLength(1);
    });

    it('face-à-face : l’annonceur annule tout, l’adversaire se retire et l’annonce se rouvre', async () => {
      const first = await newMatch();
      expect(
        (await post(t, `/matches/${first.match.id}/cancel`, undefined, bearer(capA.accessToken)))
          .statusCode,
      ).toBe(204);
      expect(
        (await prisma.opponentListing.findUniqueOrThrow({ where: { id: first.listing.id } }))
          .status,
      ).toBe('CANCELLED');
      expect((await prisma.match.findUniqueOrThrow({ where: { id: first.match.id } })).status).toBe(
        'CANCELLED',
      );

      const second = await newMatch();
      expect(
        (await post(t, `/matches/${second.match.id}/cancel`, undefined, bearer(capC.accessToken)))
          .statusCode,
      ).toBe(404); // étranger
      expect(
        (
          await post(
            t,
            `/matches/${second.match.id}/cancel`,
            undefined,
            bearer(teamB.members[0]!.accessToken),
          )
        ).statusCode,
      ).toBe(403);
      expect(
        (await post(t, `/matches/${second.match.id}/cancel`, undefined, bearer(capB.accessToken)))
          .statusCode,
      ).toBe(204);

      expect(await prisma.match.count({ where: { id: second.match.id } })).toBe(0); // le match disparaît
      expect(
        (await prisma.opponentListing.findUniqueOrThrow({ where: { id: second.listing.id } }))
          .status,
      ).toBe('OPEN');
      expect(
        (await prisma.matchRequest.findUniqueOrThrow({ where: { id: second.req.id } })).status,
      ).toBe('CANCELLED');
      expect(
        await prisma.auditLog.count({
          where: { action: 'match.withdraw', entityId: second.match.id },
        }),
      ).toBe(1);

      // L'annonce est de nouveau disponible : une autre équipe peut être acceptée.
      const reqC = (await request(capC, second.listing.id, teamC.id)).json();
      const rematch = await accept(capA, second.listing.id, reqC.id);
      expect(rematch.statusCode).toBe(200);
      expect(rematch.json().teamB.id).toBe(teamC.id);
    });

    it('un match issu d’une session solo s’annule avec la session, pas ici', async () => {
      const host = await newPlayer(t);
      const booking = await confirmedBooking(w, host);
      const session = (
        await post(
          t,
          '/solo-sessions',
          { bookingId: booking.id, spots: 3 },
          bearer(host.accessToken),
        )
      ).json();
      const res = await post(
        t,
        `/matches/${session.matchId}/cancel`,
        undefined,
        bearer(host.accessToken),
      );
      expect(res.statusCode).toBe(409);
    });

    it('on ne peut pas annuler un match déjà commencé', async () => {
      const { match } = await newMatch();
      await prisma.match.update({
        where: { id: match.id },
        data: { startsAt: new Date(Date.now() - 60_000) },
      });
      const res = await post(t, `/matches/${match.id}/cancel`, undefined, bearer(capA.accessToken));
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('SESSION_CLOSED');
    });
  });

  // ───────────────────────── Score ─────────────────────────

  describe('score', () => {
    const ended = async (matchId: string) =>
      prisma.match.update({
        where: { id: matchId },
        data: {
          startsAt: new Date(Date.now() - 7200_000),
          endsAt: new Date(Date.now() - 3600_000),
        },
      });

    it('refusé avant la fin du match', async () => {
      const { match } = await newMatch();
      const res = await put(
        t,
        `/matches/${match.id}/score`,
        { scoreA: 3, scoreB: 2 },
        capA.accessToken,
      );
      expect(res.statusCode).toBe(409);
    });

    it('un capitaine saisit le score UNE fois ; le match est terminé et les statistiques créditées', async () => {
      const { match } = await newMatch();
      await ended(match.id);

      const res = await put(
        t,
        `/matches/${match.id}/score`,
        { scoreA: 3, scoreB: 2 },
        capB.accessToken,
      );
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ status: 'COMPLETED', scoreA: 3, scoreB: 2 });
      expect(
        await prisma.auditLog.count({ where: { action: 'match.score', entityId: match.id } }),
      ).toBe(1);

      const stats = async (u: Signup) =>
        (await prisma.playerStats.findUnique({ where: { userId: u.userId } }))?.matchesPlayed ?? 0;
      expect(await stats(teamB.members[0]!)).toBeGreaterThanOrEqual(1);
      expect(await stats(teamA.members[0]!)).toBeGreaterThanOrEqual(1);
      const capAStats = await stats(capA);

      const second = await put(
        t,
        `/matches/${match.id}/score`,
        { scoreA: 0, scoreB: 9 },
        capA.accessToken,
      );
      expect(second.statusCode).toBe(409); // écriture unique
      expect((await prisma.match.findUniqueOrThrow({ where: { id: match.id } })).scoreA).toBe(3);
      await t.app.get(SocialMaintenanceService).runOnce();
      expect(await stats(capA)).toBe(capAStats); // jamais compté deux fois
      expect(await stats(teamB.members[0]!)).toBeGreaterThanOrEqual(1);
    });

    it('réservé aux capitaines du match ; valeurs bornées ; exige deux équipes', async () => {
      const { match } = await newMatch();
      await ended(match.id);
      const body = { scoreA: 1, scoreB: 1 };
      expect(
        (await put(t, `/matches/${match.id}/score`, body, teamA.members[0]!.accessToken))
          .statusCode,
      ).toBe(403);
      expect((await put(t, `/matches/${match.id}/score`, body, capC.accessToken)).statusCode).toBe(
        404,
      );
      expect((await put(t, `/matches/${match.id}/score`, body)).statusCode).toBe(401);
      for (const bad of [
        { scoreA: -1, scoreB: 0 },
        { scoreA: 100, scoreB: 0 },
        { scoreA: 1.5, scoreB: 0 },
        { scoreA: 1 },
        { scoreA: 1, scoreB: 1, winner: 'A' },
      ]) {
        expect(
          (await put(t, `/matches/${match.id}/score`, bad, capA.accessToken)).statusCode,
          JSON.stringify(bad),
        ).toBe(400);
      }

      const booking = await confirmedBooking(w, capA);
      const internal = (
        await post(
          t,
          '/matches',
          { teamId: teamA.id, bookingId: booking.id },
          bearer(capA.accessToken),
        )
      ).json();
      await ended(internal.id);
      expect(
        (await put(t, `/matches/${internal.id}/score`, body, capA.accessToken)).statusCode,
      ).toBe(409); // une seule équipe
    });

    it('un match annulé n’a pas de score', async () => {
      const { match } = await newMatch();
      await post(t, `/matches/${match.id}/cancel`, undefined, bearer(capA.accessToken));
      await ended(match.id);
      expect(
        (await put(t, `/matches/${match.id}/score`, { scoreA: 1, scoreB: 0 }, capA.accessToken))
          .statusCode,
      ).toBe(409);
    });
  });

  // ───────────────────────── Maintenance ─────────────────────────

  describe('maintenance', () => {
    it('une annonce restée sans adversaire à l’heure du match expire ; ses demandes sont rejetées', async () => {
      const { booking, listing } = await newListing();
      await request(capB, listing.id, teamB.id);
      const after = new Date(booking.startsAt.getTime() + 60_000);

      const result = await t.app.get(SocialMaintenanceService).runOnce(after);
      expect(result.expiredListings).toBeGreaterThanOrEqual(1);
      expect(
        (await prisma.opponentListing.findUniqueOrThrow({ where: { id: listing.id } })).status,
      ).toBe('EXPIRED');
      expect(
        await prisma.matchRequest.count({ where: { listingId: listing.id, status: 'REJECTED' } }),
      ).toBe(1);
      expect((await t.app.get(SocialMaintenanceService).runOnce(after)).expiredListings).toBe(0);
    });

    it('un match terminé passe à COMPLETED avec son annonce ; le client de la réservation n’est pas compté deux fois', async () => {
      const { booking, listing, match } = await newMatch();
      const before =
        (await prisma.playerStats.findUnique({ where: { userId: capA.userId } }))?.matchesPlayed ??
        0;
      const after = new Date(booking.endsAt.getTime() + 60_000);

      await t.app.get(SocialMaintenanceService).runOnce(after);
      expect((await prisma.match.findUniqueOrThrow({ where: { id: match.id } })).status).toBe(
        'COMPLETED',
      );
      expect(
        (await prisma.opponentListing.findUniqueOrThrow({ where: { id: listing.id } })).status,
      ).toBe('COMPLETED');
      expect(
        (await prisma.playerStats.findUnique({ where: { userId: capA.userId } }))?.matchesPlayed ??
          0,
      ).toBe(before);
      expect(
        (await prisma.playerStats.findUnique({ where: { userId: teamB.members[1]!.userId } }))
          ?.matchesPlayed,
      ).toBeGreaterThanOrEqual(1);
    });
  });
});
