import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type Signup,
  type TestApp,
  bearer,
  createTestApp,
  del,
  get,
  patch,
  post,
  signup,
  verifiedSignup,
} from './app-helper.js';
import { prisma, resetDb } from './helpers.js';

describe('équipes et invitations', () => {
  let t: TestApp;

  beforeAll(async () => {
    await resetDb();
    t = await createTestApp();
  });
  afterAll(() => t.close());
  beforeEach(() => {
    t.rateLimits.reset();
    t.mailer.reset();
  });

  // ───────────────────────── Outils ─────────────────────────

  let teamCounter = 0;
  const newTeam = async (captain: Signup, extra: Record<string, unknown> = {}) => {
    teamCounter += 1;
    const res = await post(t, '/teams', { name: `Équipe Test ${teamCounter} ${randomUUID().slice(0, 6)}`, ...extra }, bearer(captain.accessToken));
    if (res.statusCode !== 201) throw new Error(`Création d'équipe impossible : ${res.body}`);
    return res.json() as { id: string; name: string };
  };
  const invite = (captain: Signup, teamId: string, body: Record<string, unknown>) =>
    post(t, `/teams/${teamId}/invitations`, body, bearer(captain.accessToken));
  const accept = (user: Signup, invitationId: string) => post(t, `/invitations/${invitationId}/accept`, undefined, bearer(user.accessToken));
  /** Joueur ajouté directement à l'équipe (hors parcours d'invitation). */
  const addMember = async (teamId: string, user: Signup) => prisma.teamMember.create({ data: { teamId, userId: user.userId, role: 'MEMBER' } });
  const activeMembers = (teamId: string) => prisma.teamMember.count({ where: { teamId, leftAt: null } });

  // ───────────────────────── Création ─────────────────────────

  describe('POST /teams', () => {
    it('crée l’équipe : le créateur en devient le capitaine et l’unique membre', async () => {
      const captain = await verifiedSignup(t, { firstName: 'Yasmine', lastName: 'Benali' });
      const res = await post(t, '/teams', { name: 'Les Lions d’Alger', city: 'Alger', level: 'INTERMEDIATE', description: 'Foot le jeudi soir' }, bearer(captain.accessToken));

      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({
        name: 'Les Lions d’Alger',
        city: 'Alger',
        level: 'INTERMEDIATE',
        description: 'Foot le jeudi soir',
        captain: { id: captain.userId, name: 'Yasmine Benali' },
        memberCount: 1,
        myRole: 'CAPTAIN',
      });
      const row = await prisma.team.findUniqueOrThrow({ where: { id: res.json().id } });
      expect(row.captainId).toBe(captain.userId);
      expect(await prisma.teamMember.findFirstOrThrow({ where: { teamId: row.id } })).toMatchObject({ userId: captain.userId, role: 'CAPTAIN', leftAt: null });
      expect(await prisma.auditLog.count({ where: { action: 'team.create', entityId: row.id } })).toBe(1);
    });

    it('exige un compte connecté ET un email vérifié', async () => {
      expect((await post(t, '/teams', { name: 'Sans compte' })).statusCode).toBe(401);
      const unverified = await signup(t);
      const res = await post(t, '/teams', { name: 'Non vérifié' }, bearer(unverified.accessToken));
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('EMAIL_NOT_VERIFIED');
    });

    it('un nom désigne UNE équipe : doublon refusé, quelle que soit la casse (409)', async () => {
      const [a, b] = await Promise.all([verifiedSignup(t), verifiedSignup(t)]);
      await post(t, '/teams', { name: 'Les Aigles Unique' }, bearer(a.accessToken));
      const dup = await post(t, '/teams', { name: 'LES AIGLES UNIQUE' }, bearer(b.accessToken));
      expect(dup.statusCode).toBe(409);
      expect(dup.json().error.code).toBe('CONFLICT');
    });

    it('deux créations simultanées du même nom : une seule réussit', async () => {
      const players = await Promise.all(Array.from({ length: 4 }, () => verifiedSignup(t)));
      const results = await Promise.all(players.map((p) => post(t, '/teams', { name: 'Course Au Nom' }, bearer(p.accessToken))));
      expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
      expect(await prisma.team.count({ where: { name: 'Course Au Nom' } })).toBe(1);
    });

    it('limite à 3 équipes dirigées par joueur (TEAM_LIMIT_REACHED)', async () => {
      const captain = await verifiedSignup(t);
      for (let i = 0; i < 3; i++) await newTeam(captain);
      const res = await post(t, '/teams', { name: 'Une de trop' }, bearer(captain.accessToken));
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('TEAM_LIMIT_REACHED');
    });

    it('REFUSE les champs réservés au serveur (capitaine, logo, statut) et les noms dangereux', async () => {
      const captain = await verifiedSignup(t);
      for (const extra of [{ captainId: randomUUID() }, { logoUrl: 'https://evil.example/x.png' }, { id: randomUUID() }, { deletedAt: null }]) {
        expect((await post(t, '/teams', { name: 'Valide Nom', ...extra }, bearer(captain.accessToken))).statusCode, JSON.stringify(extra)).toBe(400);
      }
      for (const name of ['<script>', 'A', ' ', 'x'.repeat(51)]) {
        expect((await post(t, '/teams', { name }, bearer(captain.accessToken))).statusCode, name).toBe(400);
      }
    });
  });

  // ───────────────────────── Consultation ─────────────────────────

  describe('consultation', () => {
    it('la fiche est publique pour tout joueur connecté, avec mon rôle ; l’effectif reste privé', async () => {
      const captain = await verifiedSignup(t);
      const member = await verifiedSignup(t);
      const stranger = await verifiedSignup(t);
      const team = await newTeam(captain);
      await addMember(team.id, member);

      expect((await get(t, `/teams/${team.id}`, stranger.accessToken)).json()).toMatchObject({ memberCount: 2, myRole: null });
      expect((await get(t, `/teams/${team.id}`, member.accessToken)).json().myRole).toBe('MEMBER');
      expect((await get(t, `/teams/${team.id}`, captain.accessToken)).json().myRole).toBe('CAPTAIN');

      expect((await get(t, `/teams/${team.id}/members`, stranger.accessToken)).statusCode).toBe(403);
      const members = (await get(t, `/teams/${team.id}/members`, member.accessToken)).json();
      expect(members.map((m: { role: string }) => m.role)).toEqual(['CAPTAIN', 'MEMBER']);
      expect(Object.keys(members[0]).sort()).toEqual(['avatarUrl', 'id', 'joinedAt', 'level', 'name', 'preferredPosition', 'role']);
    });

    it('ne divulgue jamais email, téléphone ni date de naissance des membres', async () => {
      const captain = await verifiedSignup(t);
      const team = await newTeam(captain);
      const res = await get(t, `/teams/${team.id}/members`, captain.accessToken);
      expect(res.body).not.toMatch(/email|phone|birthDate|passwordHash|@/);
    });

    it('404 pour une équipe inconnue ou dissoute ; 400 pour un identifiant invalide ; 401 sans jeton', async () => {
      const captain = await verifiedSignup(t);
      expect((await get(t, `/teams/${randomUUID()}`, captain.accessToken)).statusCode).toBe(404);
      expect((await get(t, '/teams/pas-un-uuid', captain.accessToken)).statusCode).toBe(400);
      expect((await get(t, `/teams/${randomUUID()}`)).statusCode).toBe(401);
    });

    it('recherche par nom, ville et niveau ; pagine ; exclut les équipes dissoutes', async () => {
      const captain = await verifiedSignup(t);
      const [c2, c3] = await Promise.all([verifiedSignup(t), verifiedSignup(t)]);
      await post(t, '/teams', { name: 'Rech Alpha', city: 'Blida', level: 'ADVANCED' }, bearer(captain.accessToken));
      await post(t, '/teams', { name: 'Rech Beta', city: 'Blida', level: 'BEGINNER' }, bearer(c2.accessToken));
      const gone = (await post(t, '/teams', { name: 'Rech Gamma', city: 'Blida' }, bearer(c3.accessToken))).json();
      await del(t, `/teams/${gone.id}`, c3.accessToken);

      const names = async (query: string) => (await get(t, `/teams?${query}`, captain.accessToken)).json().items.map((x: { name: string }) => x.name);
      expect(await names('city=blida')).toEqual(['Rech Alpha', 'Rech Beta']);
      expect(await names('q=rech&level=ADVANCED')).toEqual(['Rech Alpha']);

      const page1 = (await get(t, '/teams?city=Blida&limit=1', captain.accessToken)).json();
      expect(page1.items).toHaveLength(1);
      const page2 = (await get(t, `/teams?city=Blida&limit=1&cursor=${page1.nextCursor}`, captain.accessToken)).json();
      expect([...page1.items, ...page2.items].map((x: { name: string }) => x.name)).toEqual(['Rech Alpha', 'Rech Beta']);
      expect(page2.nextCursor).toBeNull();
      expect((await get(t, '/teams?cursor=abc', captain.accessToken)).statusCode).toBe(400);
    });

    it('GET /me/teams ne liste que mes équipes', async () => {
      const [a, b] = await Promise.all([verifiedSignup(t), verifiedSignup(t)]);
      const mine = await newTeam(a);
      await newTeam(b);
      expect((await get(t, '/me/teams', a.accessToken)).json().map((x: { id: string }) => x.id)).toEqual([mine.id]);
    });
  });

  // ───────────────────────── Modification ─────────────────────────

  describe('PATCH /teams/:id', () => {
    it('le capitaine modifie son équipe ; un membre ou un tiers reçoit 403 NOT_CAPTAIN', async () => {
      const [captain, member, stranger] = await Promise.all([verifiedSignup(t), verifiedSignup(t), verifiedSignup(t)]);
      const team = await newTeam(captain);
      await addMember(team.id, member);

      const ok = await patch(t, `/teams/${team.id}`, { city: 'Oran', level: 'ADVANCED' }, captain.accessToken);
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toMatchObject({ city: 'Oran', level: 'ADVANCED' });

      for (const user of [member, stranger]) {
        const res = await patch(t, `/teams/${team.id}`, { city: 'Pirate' }, user.accessToken);
        expect(res.statusCode).toBe(403);
        expect(res.json().error.code).toBe('NOT_CAPTAIN');
      }
      expect((await prisma.team.findUniqueOrThrow({ where: { id: team.id } })).city).toBe('Oran');
    });

    it('REFUSE de changer le capitaine, le logo ou le statut ; refuse une requête vide ; journalise avant/après', async () => {
      const captain = await verifiedSignup(t);
      const team = await newTeam(captain);
      for (const field of ['captainId', 'logoUrl', 'deletedAt']) {
        expect((await patch(t, `/teams/${team.id}`, { [field]: 'x' }, captain.accessToken)).statusCode, field).toBe(400);
      }
      expect((await patch(t, `/teams/${team.id}`, {}, captain.accessToken)).statusCode).toBe(400);

      await patch(t, `/teams/${team.id}`, { description: 'Nouvelle description' }, captain.accessToken);
      const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'team.update', entityId: team.id } });
      expect(audit.before).toMatchObject({ description: null });
      expect(audit.after).toMatchObject({ description: 'Nouvelle description' });
    });

    it('refuse un nom déjà pris par une autre équipe', async () => {
      const [a, b] = await Promise.all([verifiedSignup(t), verifiedSignup(t)]);
      const first = await newTeam(a);
      const second = await newTeam(b);
      expect((await patch(t, `/teams/${second.id}`, { name: first.name.toUpperCase() }, b.accessToken)).statusCode).toBe(409);
    });
  });

  // ───────────────────────── Invitations ─────────────────────────

  describe('invitations', () => {
    it('invite un joueur par son compte ; il la voit, l’accepte et rejoint l’équipe', async () => {
      const [captain, player] = await Promise.all([verifiedSignup(t), verifiedSignup(t)]);
      const team = await newTeam(captain);

      const res = await invite(captain, team.id, { userId: player.userId });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ status: 'PENDING', team: { id: team.id }, invitee: expect.any(String) });

      const mine = (await get(t, '/me/invitations', player.accessToken)).json();
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({ id: res.json().id, team: { id: team.id, name: team.name }, status: 'PENDING' });
      expect(Object.keys(mine[0]).sort()).toEqual(['createdAt', 'expiresAt', 'id', 'invitedBy', 'status', 'team']);

      const joined = await accept(player, res.json().id);
      expect(joined.statusCode).toBe(200);
      expect(joined.json()).toMatchObject({ memberCount: 2, myRole: 'MEMBER' });
      expect((await get(t, '/me/invitations', player.accessToken)).json()).toEqual([]);
      expect(await activeMembers(team.id)).toBe(2);
    });

    it('invite par email : un compte existant est relié, un email inconnu reçoit un message', async () => {
      const [captain, existing] = await Promise.all([verifiedSignup(t), verifiedSignup(t)]);
      const team = await newTeam(captain);
      t.mailer.reset(); // les inscriptions ci-dessus ont déjà envoyé leurs emails de vérification

      const known = await invite(captain, team.id, { email: existing.email });
      expect(known.statusCode).toBe(201);
      expect((await prisma.teamInvitation.findUniqueOrThrow({ where: { id: known.json().id } }))).toMatchObject({ inviteeId: existing.userId, inviteeEmail: null });
      expect(t.mailer.to(existing.email)).toHaveLength(0); // le compte existant est notifié dans l'application

      const unknown = await invite(captain, team.id, { email: 'Futur.Joueur@Example.com' });
      expect(unknown.statusCode).toBe(201);
      expect(unknown.json().invitee).toBe('futur.joueur@example.com');
      expect(t.mailer.to('futur.joueur@example.com')).toHaveLength(1);
      expect(t.mailer.to('futur.joueur@example.com')[0]?.text).toContain(team.name);
    });

    it('une invitation par email d’un futur joueur n’est acceptable qu’avec cette adresse VÉRIFIÉE', async () => {
      const captain = await verifiedSignup(t);
      const team = await newTeam(captain);
      const email = `futur-${randomUUID()}@example.com`;
      const inv = (await invite(captain, team.id, { email })).json();

      const newcomer = await signup(t, { email }); // compte créé, email pas encore vérifié
      expect((await get(t, '/me/invitations', newcomer.accessToken)).json()).toEqual([]);
      expect((await accept(newcomer, inv.id)).statusCode).toBe(403);

      await post(t, '/auth/verify-email', { token: t.mailer.lastToken(email) });
      expect((await get(t, '/me/invitations', newcomer.accessToken)).json()).toHaveLength(1);
      expect((await accept(newcomer, inv.id)).statusCode).toBe(200);
      expect(await prisma.teamMember.count({ where: { teamId: team.id, userId: newcomer.userId, leftAt: null } })).toBe(1);
    });

    it('seul le capitaine invite ; exactement un de userId / email', async () => {
      const [captain, member, stranger, target] = await Promise.all([verifiedSignup(t), verifiedSignup(t), verifiedSignup(t), verifiedSignup(t)]);
      const team = await newTeam(captain);
      await addMember(team.id, member);

      for (const user of [member, stranger]) {
        const res = await invite(user, team.id, { userId: target.userId });
        expect(res.statusCode).toBe(403);
        expect(res.json().error.code).toBe('NOT_CAPTAIN');
      }
      expect((await invite(captain, team.id, {})).statusCode).toBe(400);
      expect((await invite(captain, team.id, { userId: target.userId, email: 'a@b.co' })).statusCode).toBe(400);
      expect((await invite(captain, team.id, { userId: randomUUID() })).statusCode).toBe(404);
      expect(await prisma.teamInvitation.count({ where: { teamId: team.id } })).toBe(0);
    });

    it('refuse : s’inviter soi-même, un membre actuel, un doublon en attente (compte ou email)', async () => {
      const [captain, member, target] = await Promise.all([verifiedSignup(t), verifiedSignup(t), verifiedSignup(t)]);
      const team = await newTeam(captain);
      await addMember(team.id, member);

      expect((await invite(captain, team.id, { userId: captain.userId })).statusCode).toBe(409);
      const already = await invite(captain, team.id, { userId: member.userId });
      expect(already.statusCode).toBe(409);
      expect(already.json().error.code).toBe('ALREADY_JOINED');

      expect((await invite(captain, team.id, { userId: target.userId })).statusCode).toBe(201);
      expect((await invite(captain, team.id, { userId: target.userId })).statusCode).toBe(409);
      expect((await invite(captain, team.id, { email: 'nouveau@example.com' })).statusCode).toBe(201);
      expect((await invite(captain, team.id, { email: 'NOUVEAU@example.com' })).statusCode).toBe(409);
    });

    it('refuse d’inviter quand l’équipe est complète (25 joueurs)', async () => {
      const captain = await verifiedSignup(t);
      const team = await newTeam(captain);
      const players = await Promise.all(Array.from({ length: 24 }, () => signup(t)));
      await prisma.teamMember.createMany({ data: players.map((p) => ({ teamId: team.id, userId: p.userId })) });
      const target = await verifiedSignup(t);

      const res = await invite(captain, team.id, { userId: target.userId });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('TEAM_FULL');
    });

    it('un tiers ne peut pas accepter l’invitation d’un autre (404) ; elle reste valable pour le bon destinataire', async () => {
      const [captain, player, thief] = await Promise.all([verifiedSignup(t), verifiedSignup(t), verifiedSignup(t)]);
      const team = await newTeam(captain);
      const inv = (await invite(captain, team.id, { userId: player.userId })).json();

      expect((await accept(thief, inv.id)).statusCode).toBe(404);
      expect(await prisma.teamMember.count({ where: { teamId: team.id, userId: thief.userId } })).toBe(0);
      expect((await accept(player, inv.id)).statusCode).toBe(200);
    });

    it('à usage unique : la même invitation acceptée 5 fois EN MÊME TEMPS ne crée qu’UN membre', async () => {
      const [captain, player] = await Promise.all([verifiedSignup(t), verifiedSignup(t)]);
      const team = await newTeam(captain);
      const inv = (await invite(captain, team.id, { userId: player.userId })).json();

      const results = await Promise.all(Array.from({ length: 5 }, () => accept(player, inv.id)));
      expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
      expect(await prisma.teamMember.count({ where: { teamId: team.id, userId: player.userId, leftAt: null } })).toBe(1);
    });

    it('refuse une invitation expirée, annulée, déjà refusée ; l’équipe dissoute', async () => {
      const [captain, player] = await Promise.all([verifiedSignup(t), verifiedSignup(t)]);
      const team = await newTeam(captain);
      const expired = (await invite(captain, team.id, { userId: player.userId })).json();
      await prisma.teamInvitation.update({ where: { id: expired.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      expect((await accept(player, expired.id)).statusCode).toBe(404);
      expect((await get(t, '/me/invitations', player.accessToken)).json()).toEqual([]);

      const other = await newTeam(captain);
      const cancelled = (await invite(captain, other.id, { userId: player.userId })).json();
      expect((await del(t, `/teams/${other.id}/invitations/${cancelled.id}`, captain.accessToken)).statusCode).toBe(204);
      expect((await accept(player, cancelled.id)).statusCode).toBe(404);

      const third = await newTeam(captain);
      const declined = (await invite(captain, third.id, { userId: player.userId })).json();
      expect((await post(t, `/invitations/${declined.id}/decline`, undefined, bearer(player.accessToken))).statusCode).toBe(204);
      expect((await accept(player, declined.id)).statusCode).toBe(404);

      await del(t, `/teams/${third.id}`, captain.accessToken); // libère un des 3 emplacements d'équipe du capitaine
      const fourth = await newTeam(captain);
      const pending = (await invite(captain, fourth.id, { userId: player.userId })).json();
      await del(t, `/teams/${fourth.id}`, captain.accessToken);
      expect((await accept(player, pending.id)).statusCode).toBe(404);
    });

    it('si l’équipe devient complète entre-temps : 409 TEAM_FULL et l’invitation reste en attente', async () => {
      const [captain, player] = await Promise.all([verifiedSignup(t), verifiedSignup(t)]);
      const team = await newTeam(captain);
      const inv = (await invite(captain, team.id, { userId: player.userId })).json();
      const fillers = await Promise.all(Array.from({ length: 24 }, () => signup(t)));
      await prisma.teamMember.createMany({ data: fillers.map((p) => ({ teamId: team.id, userId: p.userId })) });

      const res = await accept(player, inv.id);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('TEAM_FULL');
      expect((await prisma.teamInvitation.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe('PENDING'); // transaction annulée
    });

    it('le capitaine liste ses invitations en attente ; un tiers n’y a pas accès', async () => {
      const [captain, player, stranger] = await Promise.all([verifiedSignup(t), verifiedSignup(t), verifiedSignup(t)]);
      const team = await newTeam(captain);
      await invite(captain, team.id, { userId: player.userId });
      await invite(captain, team.id, { email: 'attente@example.com' });

      const list = (await get(t, `/teams/${team.id}/invitations`, captain.accessToken)).json();
      expect(list).toHaveLength(2);
      expect((await get(t, `/teams/${team.id}/invitations`, stranger.accessToken)).statusCode).toBe(403);
    });

    it('un capitaine ne peut pas annuler l’invitation d’une AUTRE équipe', async () => {
      const [a, b, player] = await Promise.all([verifiedSignup(t), verifiedSignup(t), verifiedSignup(t)]);
      const teamA = await newTeam(a);
      const teamB = await newTeam(b);
      const inv = (await invite(a, teamA.id, { userId: player.userId })).json();
      expect((await del(t, `/teams/${teamB.id}/invitations/${inv.id}`, b.accessToken)).statusCode).toBe(404);
      expect((await prisma.teamInvitation.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe('PENDING');
    });

    it('limite les invitations : 30 par jour et par capitaine', async () => {
      const captain = await verifiedSignup(t);
      const team = await newTeam(captain);
      let limited = 0;
      for (let i = 0; i < 32; i++) {
        const res = await invite(captain, team.id, { email: `rate-${i}-${randomUUID().slice(0, 4)}@example.com` });
        if (res.statusCode === 429) limited += 1;
      }
      expect(limited).toBe(2);
    });
  });

  // ───────────────────────── Membres ─────────────────────────

  describe('membres, départ et capitainerie', () => {
    it('le capitaine retire un joueur (l’historique est conservé) ; un tiers ne peut pas', async () => {
      const [captain, member, stranger] = await Promise.all([verifiedSignup(t), verifiedSignup(t), verifiedSignup(t)]);
      const team = await newTeam(captain);
      await addMember(team.id, member);

      expect((await del(t, `/teams/${team.id}/members/${member.userId}`, stranger.accessToken)).statusCode).toBe(403);
      expect((await del(t, `/teams/${team.id}/members/${member.userId}`, captain.accessToken)).statusCode).toBe(204);
      expect(await activeMembers(team.id)).toBe(1);
      expect(await prisma.teamMember.count({ where: { teamId: team.id, userId: member.userId, leftAt: { not: null } } })).toBe(1);
      expect((await del(t, `/teams/${team.id}/members/${member.userId}`, captain.accessToken)).statusCode).toBe(404);
    });

    it('le capitaine ne peut pas se retirer lui-même', async () => {
      const captain = await verifiedSignup(t);
      const team = await newTeam(captain);
      expect((await del(t, `/teams/${team.id}/members/${captain.userId}`, captain.accessToken)).statusCode).toBe(409);
    });

    it('un membre peut quitter l’équipe, puis être réinvité', async () => {
      const [captain, member] = await Promise.all([verifiedSignup(t), verifiedSignup(t)]);
      const team = await newTeam(captain);
      await addMember(team.id, member);
      expect((await post(t, `/teams/${team.id}/leave`, undefined, bearer(member.accessToken))).statusCode).toBe(204);
      expect(await activeMembers(team.id)).toBe(1);

      const inv = await invite(captain, team.id, { userId: member.userId });
      expect(inv.statusCode).toBe(201);
      expect((await accept(member, inv.json().id)).statusCode).toBe(200);
      expect(await activeMembers(team.id)).toBe(2);
    });

    it('un capitaine qui a des coéquipiers doit d’abord transférer la capitainerie ; seul, il dissout l’équipe en partant', async () => {
      const [captain, member] = await Promise.all([verifiedSignup(t), verifiedSignup(t)]);
      const team = await newTeam(captain);
      await addMember(team.id, member);
      expect((await post(t, `/teams/${team.id}/leave`, undefined, bearer(captain.accessToken))).statusCode).toBe(409);

      const alone = await verifiedSignup(t);
      const solo = await newTeam(alone);
      expect((await post(t, `/teams/${solo.id}/leave`, undefined, bearer(alone.accessToken))).statusCode).toBe(204);
      expect((await prisma.team.findUniqueOrThrow({ where: { id: solo.id } })).deletedAt).not.toBeNull();
    });

    it('transfère la capitainerie : un seul capitaine, l’ancien devient membre, l’action est auditée', async () => {
      const [captain, member] = await Promise.all([verifiedSignup(t), verifiedSignup(t)]);
      const team = await newTeam(captain);
      await addMember(team.id, member);

      const res = await post(t, `/teams/${team.id}/transfer-captaincy`, { userId: member.userId }, bearer(captain.accessToken));
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ captain: { id: member.userId }, myRole: 'MEMBER' });
      expect((await prisma.team.findUniqueOrThrow({ where: { id: team.id } })).captainId).toBe(member.userId);
      expect(await prisma.teamMember.count({ where: { teamId: team.id, role: 'CAPTAIN', leftAt: null } })).toBe(1);
      expect(await prisma.auditLog.count({ where: { action: 'team.transfer_captaincy', entityId: team.id } })).toBe(1);

      // L'ancien capitaine a perdu ses droits, le nouveau les a
      expect((await patch(t, `/teams/${team.id}`, { city: 'Oran' }, captain.accessToken)).statusCode).toBe(403);
      expect((await patch(t, `/teams/${team.id}`, { city: 'Oran' }, member.accessToken)).statusCode).toBe(200);
    });

    it('ne transfère qu’à un membre actif de l’équipe, et seulement par le capitaine', async () => {
      const [captain, member, stranger] = await Promise.all([verifiedSignup(t), verifiedSignup(t), verifiedSignup(t)]);
      const team = await newTeam(captain);
      await addMember(team.id, member);

      expect((await post(t, `/teams/${team.id}/transfer-captaincy`, { userId: stranger.userId }, bearer(captain.accessToken))).statusCode).toBe(404);
      expect((await post(t, `/teams/${team.id}/transfer-captaincy`, { userId: captain.userId }, bearer(captain.accessToken))).statusCode).toBe(409);
      expect((await post(t, `/teams/${team.id}/transfer-captaincy`, { userId: stranger.userId }, bearer(member.accessToken))).statusCode).toBe(403);
      expect((await prisma.team.findUniqueOrThrow({ where: { id: team.id } })).captainId).toBe(captain.userId);
    });
  });

  // ───────────────────────── Dissolution ─────────────────────────

  describe('DELETE /teams/:id', () => {
    it('dissout l’équipe : membres sortis, invitations annulées, introuvable ensuite ; le nom redevient disponible', async () => {
      const [captain, member, invitee] = await Promise.all([verifiedSignup(t), verifiedSignup(t), verifiedSignup(t)]);
      const team = await newTeam(captain, { name: 'Équipe Éphémère' });
      await addMember(team.id, member);
      await invite(captain, team.id, { userId: invitee.userId });

      expect((await del(t, `/teams/${team.id}`, captain.accessToken)).statusCode).toBe(204);
      expect(await activeMembers(team.id)).toBe(0);
      expect(await prisma.teamInvitation.count({ where: { teamId: team.id, status: 'PENDING' } })).toBe(0);
      expect((await get(t, `/teams/${team.id}`, captain.accessToken)).statusCode).toBe(404);
      expect((await post(t, '/teams', { name: 'Équipe Éphémère' }, bearer(captain.accessToken))).statusCode).toBe(201);
    });

    it('seul le capitaine peut dissoudre', async () => {
      const [captain, member] = await Promise.all([verifiedSignup(t), verifiedSignup(t)]);
      const team = await newTeam(captain);
      await addMember(team.id, member);
      expect((await del(t, `/teams/${team.id}`, member.accessToken)).statusCode).toBe(403);
      expect((await prisma.team.findUniqueOrThrow({ where: { id: team.id } })).deletedAt).toBeNull();
    });
  });
});
