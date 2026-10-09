import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedBaseline } from '../../src/infra/database/baseline.js';
import { SettingsService } from '../../src/modules/settings/settings.service.js';
import { type Signup, type TestApp, bearer, createTestApp, del, get, post, put, verifiedSignup } from './app-helper.js';
import { prisma, resetDb } from './helpers.js';
import { type World, createWorld, newPlayer } from './social-fixtures.js';
import { book, createVenue, createVenueWithFields, dayIn, slotAt } from './venue-fixtures.js';

describe('administration, tableaux de bord et personnel', () => {
  let t: TestApp;
  let boss: Signup;

  beforeAll(async () => {
    await resetDb();
    await seedBaseline(prisma);
    t = await createTestApp();
    boss = await makeAdmin();
  });
  afterAll(() => t.close());
  beforeEach(() => t.rateLimits.reset());

  // ───────────────────────── Outils ─────────────────────────

  async function makeAdmin(): Promise<Signup> {
    const user = await verifiedSignup(t);
    await prisma.user.update({ where: { id: user.userId }, data: { platformRole: 'ADMIN' } });
    return user;
  }
  const as = (u: Signup) => bearer(u.accessToken);
  const getAs = (u: Signup | null, url: string) => get(t, url, u?.accessToken);
  const postAs = (u: Signup, url: string, body?: unknown) => post(t, url, body, as(u));

  /** Complexe en attente avec un propriétaire, un gérant et un simple membre du personnel. */
  async function pendingVenue(opts: { fields?: boolean; city?: string; name?: string } = {}) {
    const venue = opts.fields === false
      ? await createVenue({ status: 'PENDING', city: opts.city, name: opts.name })
      : (await createVenueWithFields({ status: 'PENDING', city: opts.city, name: opts.name }, [{ capacity: 10 }])).venue;
    const [owner, manager, staff] = await Promise.all([verifiedSignup(t), verifiedSignup(t), verifiedSignup(t)]);
    await prisma.venueStaff.createMany({
      data: [
        { venueId: venue.id, userId: owner.userId, role: 'OWNER' },
        { venueId: venue.id, userId: manager.userId, role: 'MANAGER' },
        { venueId: venue.id, userId: staff.userId, role: 'STAFF' },
      ],
    });
    t.mailer.reset();
    return { venue, owner, manager, staff };
  }
  const notifTypes = async (u: Signup) => (await get(t, '/me/notifications', u.accessToken)).json().items.map((n: { type: string }) => n.type);

  // ───────────────────────── Accès ─────────────────────────

  describe('contrôle d’accès', () => {
    it('toutes les routes d’administration refusent anonymes (401), joueurs et propriétaires de complexe (403)', async () => {
      const player = await newPlayer(t);
      const { owner } = await pendingVenue();
      const id = randomUUID();
      const routes: ['GET' | 'POST' | 'PUT' | 'DELETE', string][] = [
        ['GET', '/admin/venues'], ['GET', `/admin/venues/${id}`], ['POST', `/admin/venues/${id}/approve`], ['POST', `/admin/venues/${id}/reject`],
        ['POST', `/admin/venues/${id}/suspend`], ['POST', `/admin/venues/${id}/reinstate`], ['PUT', `/admin/venues/${id}/deposit-policy`],
        ['GET', '/admin/users'], ['GET', `/admin/users/${id}`], ['POST', `/admin/users/${id}/block`], ['POST', `/admin/users/${id}/unblock`],
        ['GET', '/admin/commission'], ['PUT', '/admin/commission/global'], ['PUT', `/admin/commission/venues/${id}`], ['DELETE', `/admin/commission/venues/${id}`],
        ['GET', '/admin/settings'], ['PUT', '/admin/settings/booking.hold_minutes'],
        ['GET', '/admin/stats?from=2027-01-01&to=2027-01-02'], ['GET', '/admin/audit-logs'], ['GET', '/admin/refunds'], ['POST', `/admin/refunds/${id}/retry`],
        ['POST', `/admin/bookings/${id}/refund`], ['GET', '/admin/reviews'], ['POST', `/admin/reviews/${id}/hide`], ['POST', `/admin/reviews/${id}/unhide`],
      ];
      for (const [method, url] of routes) {
        for (const [who, user, expected] of [['anonyme', null, 401], ['joueur', player, 403], ['propriétaire', owner, 403]] as const) {
          const res = await t.app.inject({ method, url: `/api/v1${url}`, payload: method === 'GET' || method === 'DELETE' ? undefined : {}, headers: user ? as(user) : {} });
          expect(res.statusCode, `${method} ${url} (${who})`).toBe(expected);
        }
      }
    });

    it('un rôle ADMIN accordé en base prend effet immédiatement, et retiré aussi (le jeton ne fait pas foi)', async () => {
      const user = await verifiedSignup(t);
      expect((await getAs(user, '/admin/venues')).statusCode).toBe(403);
      await prisma.user.update({ where: { id: user.userId }, data: { platformRole: 'ADMIN' } });
      expect((await getAs(user, '/admin/venues')).statusCode).toBe(200);
      await prisma.user.update({ where: { id: user.userId }, data: { platformRole: 'USER' } });
      expect((await getAs(user, '/admin/venues')).statusCode).toBe(403);
    });
  });

  // ───────────────────────── Complexes ─────────────────────────

  describe('validation des complexes', () => {
    it('liste : demandes en attente d’abord, filtres, propriétaires avec contact, taux de commission effectif', async () => {
      const a = await pendingVenue({ city: 'Biskra', name: 'Complexe Biskra Un' });
      const b = await pendingVenue({ city: 'Biskra', name: 'Complexe Biskra Deux' });
      const approved = await createVenue({ city: 'Biskra', name: 'Complexe Biskra Trois' });

      const all = (await getAs(boss, '/admin/venues?city=biskra')).json();
      expect(all.items.map((v: { id: string }) => v.id).slice(0, 3).sort()).toEqual([a.venue.id, b.venue.id, approved.id].sort());
      expect(all.items[0].status).toBe('PENDING'); // les demandes à traiter en tête
      const pending = (await getAs(boss, '/admin/venues?status=PENDING&city=biskra')).json().items;
      expect(pending.map((v: { id: string }) => v.id)).toEqual([a.venue.id, b.venue.id]); // plus anciennes d'abord
      expect(pending[0]).toMatchObject({ status: 'PENDING', fieldCount: 1, commission: { rateBps: 100, scope: 'GLOBAL' } });
      expect(pending[0].owners).toEqual([expect.objectContaining({ id: a.owner.userId, email: a.owner.email })]);
      expect((await getAs(boss, '/admin/venues?q=deux')).json().items.map((v: { id: string }) => v.id)).toEqual([b.venue.id]);
      expect((await getAs(boss, '/admin/venues?status=NOPE')).statusCode).toBe(400);
      expect((await getAs(boss, '/admin/venues?limit=1&city=biskra')).json().nextCursor).not.toBeNull();
    });

    it('approuver : le complexe devient public, les gérants (pas le simple personnel) sont prévenus, la décision est auditée', async () => {
      const { venue, owner, manager, staff } = await pendingVenue();
      expect((await getAs(null, `/venues/${venue.slug}`)).statusCode).toBe(404);

      const res = await postAs(boss, `/admin/venues/${venue.id}/approve`, { reason: 'Dossier complet' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ status: 'APPROVED', statusReason: 'Dossier complet' });
      expect((await getAs(null, `/venues/${venue.slug}`)).statusCode).toBe(200);

      expect(await notifTypes(owner)).toEqual(['VENUE_APPROVED']);
      expect(await notifTypes(manager)).toEqual(['VENUE_APPROVED']);
      expect(await notifTypes(staff)).toEqual([]);
      expect(t.mailer.to(owner.email)).toHaveLength(1);
      const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'venue.approve', entityId: venue.id } });
      expect(audit).toMatchObject({ actorId: boss.userId, actorRole: 'ADMIN', before: { status: 'PENDING' } });
    });

    it('un complexe sans terrain actif ne peut pas être approuvé', async () => {
      const { venue } = await pendingVenue({ fields: false });
      const res = await postAs(boss, `/admin/venues/${venue.id}/approve`, {});
      expect(res.statusCode).toBe(409);
      expect((await prisma.venue.findUniqueOrThrow({ where: { id: venue.id } })).status).toBe('PENDING');
    });

    it('refuser : motif obligatoire, communiqué aux gérants ; un complexe refusé peut être réexaminé et approuvé', async () => {
      const { venue, owner } = await pendingVenue();
      expect((await postAs(boss, `/admin/venues/${venue.id}/reject`, {})).statusCode).toBe(400);
      expect((await postAs(boss, `/admin/venues/${venue.id}/reject`, { reason: 'x' })).statusCode).toBe(400); // trop court

      const res = await postAs(boss, `/admin/venues/${venue.id}/reject`, { reason: 'Adresse introuvable' });
      expect(res.json()).toMatchObject({ status: 'REJECTED', statusReason: 'Adresse introuvable' });
      const [notif] = (await get(t, '/me/notifications', owner.accessToken)).json().items;
      expect(notif).toMatchObject({ type: 'VENUE_REJECTED' });
      expect(notif.body).toContain('Adresse introuvable');
      expect((await getAs(null, `/venues/${venue.slug}`)).statusCode).toBe(404);

      expect((await postAs(boss, `/admin/venues/${venue.id}/approve`, {})).json().status).toBe('APPROVED');
    });

    it('suspendre masque le complexe partout, rétablir le rend ; seules les transitions valides sont acceptées', async () => {
      const { venue, owner } = await pendingVenue();
      expect((await postAs(boss, `/admin/venues/${venue.id}/suspend`, { reason: 'Plaintes répétées' })).statusCode).toBe(409); // pas encore approuvé
      expect((await postAs(boss, `/admin/venues/${venue.id}/reinstate`, {})).statusCode).toBe(409);
      await postAs(boss, `/admin/venues/${venue.id}/approve`, {});
      expect((await postAs(boss, `/admin/venues/${venue.id}/approve`, {})).statusCode).toBe(409); // déjà approuvé
      expect((await postAs(boss, `/admin/venues/${venue.id}/reject`, { reason: 'Trop tard' })).statusCode).toBe(409);

      expect((await postAs(boss, `/admin/venues/${venue.id}/suspend`, { reason: 'Plaintes répétées' })).json().status).toBe('SUSPENDED');
      expect((await getAs(null, `/venues/${venue.slug}`)).statusCode).toBe(404);
      const listed = (await getAs(null, `/venues?q=${encodeURIComponent(venue.name)}`)).json();
      expect(JSON.stringify(listed)).not.toContain(venue.id);
      const field = await prisma.field.findFirstOrThrow({ where: { venueId: venue.id } });
      const player = await newPlayer(t);
      const quote = await postAs(player, '/bookings/quote', { fieldId: field.id, startsAt: new Date(Date.now() + 3 * 86_400_000).toISOString() });
      expect(quote.statusCode).not.toBe(200);
      expect((await notifTypes(owner))[0]).toBe('VENUE_SUSPENDED');

      expect((await postAs(boss, `/admin/venues/${venue.id}/reinstate`, {})).json().status).toBe('APPROVED');
      expect((await getAs(null, `/venues/${venue.slug}`)).statusCode).toBe(200);
      expect((await prisma.venue.findUniqueOrThrow({ where: { id: venue.id } })).statusReason).toBeNull();
    });

    it('CONCURRENCE : approuver et refuser en même temps → une seule décision l’emporte', async () => {
      const { venue } = await pendingVenue();
      const second = await makeAdmin();
      const results = await Promise.all([
        postAs(boss, `/admin/venues/${venue.id}/approve`, {}),
        postAs(second, `/admin/venues/${venue.id}/reject`, { reason: 'Refus simultané' }),
        postAs(boss, `/admin/venues/${venue.id}/approve`, {}),
      ]);
      expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
      const status = (await prisma.venue.findUniqueOrThrow({ where: { id: venue.id } })).status;
      expect(['APPROVED', 'REJECTED']).toContain(status);
      expect(await prisma.auditLog.count({ where: { entityId: venue.id, action: { in: ['venue.approve', 'venue.reject'] } } })).toBe(1);
    });

    it('acompte propre à un complexe : défini par l’administration, remplace la règle par défaut dans les devis, null pour revenir', async () => {
      const world = await createWorld(t);
      const player = await newPlayer(t);
      const quoteNow = async () => (await postAs(player, '/bookings/quote', { fieldId: world.small.id, startsAt: slotAt(dayIn(9), '14:00').toISOString() })).json();
      expect((await quoteNow()).dueOnlineMinor).toBe(800); // règle par défaut : 20 % de 4 000 DA

      const policy = { mode: 'PERCENT', rateBps: 5000, fixedMinor: 0, minMinor: 0 };
      const res = await t.app.inject({ method: 'PUT', url: `/api/v1/admin/venues/${world.venue.id}/deposit-policy`, payload: { depositPolicy: policy }, headers: as(boss) });
      expect(res.statusCode).toBe(200);
      expect(res.json().depositPolicy).toEqual(policy);
      expect(await prisma.auditLog.count({ where: { action: 'venue.deposit_policy', entityId: world.venue.id } })).toBe(1);

      expect(await quoteNow()).toMatchObject({ priceMinor: 4000, dueOnlineMinor: 2000 }); // 50 % propre à ce complexe

      const reset = await t.app.inject({ method: 'PUT', url: `/api/v1/admin/venues/${world.venue.id}/deposit-policy`, payload: { depositPolicy: null }, headers: as(boss) });
      expect(reset.json().depositPolicy).toBeNull();
      expect((await quoteNow()).dueOnlineMinor).toBe(800); // retour à la règle par défaut
      for (const bad of [{ depositPolicy: { mode: 'PERCENT', rateBps: 20_000, fixedMinor: 0, minMinor: 0 } }, { depositPolicy: { mode: 'WAT' } }, {}, { depositPolicy: null, extra: 1 }]) {
        const r = await t.app.inject({ method: 'PUT', url: `/api/v1/admin/venues/${world.venue.id}/deposit-policy`, payload: bad, headers: as(boss) });
        expect(r.statusCode, JSON.stringify(bad)).toBe(400);
      }
      expect((await t.app.inject({ method: 'PUT', url: `/api/v1/admin/venues/${randomUUID()}/deposit-policy`, payload: { depositPolicy: null }, headers: as(boss) })).statusCode).toBe(404);
    });
  });

  // ───────────────────────── Utilisateurs ─────────────────────────

  describe('utilisateurs', () => {
    it('recherche par email, nom, téléphone, statut et rôle, sans jamais exposer de secret', async () => {
      const user = await newPlayer(t);
      const found = (await getAs(boss, `/admin/users?q=${encodeURIComponent(user.email.slice(0, 20))}`)).json();
      expect(found.items.map((u: { id: string }) => u.id)).toContain(user.userId);
      expect(JSON.stringify(found)).not.toMatch(/passwordHash|refreshToken|argon2/i);
      expect((await getAs(boss, '/admin/users?role=ADMIN')).json().items.every((u: { platformRole: string }) => u.platformRole === 'ADMIN')).toBe(true);
      expect((await getAs(boss, `/admin/users/${user.userId}`)).json()).toMatchObject({ id: user.userId, status: 'ACTIVE', reliabilityScore: 100, emailVerified: true });
      expect((await getAs(boss, `/admin/users/${randomUUID()}`)).statusCode).toBe(404);
    });

    it('bloquer : motif obligatoire, sessions révoquées, plus aucune requête ni connexion ; débloquer rétablit', async () => {
      const user = await newPlayer(t);
      expect((await postAs(boss, `/admin/users/${user.userId}/block`, {})).statusCode).toBe(400);

      const res = await postAs(boss, `/admin/users/${user.userId}/block`, { reason: 'Fraude au paiement' });
      expect(res.json().status).toBe('BLOCKED');
      expect((await getAs(user, '/me')).statusCode).toBe(401); // session révoquée : le jeton ne vaut plus rien
      const login = await post(t, '/auth/login', { email: user.email, password: user.password });
      expect(login.json().error.code).toBe('ACCOUNT_BLOCKED');
      const refresh = await post(t, '/auth/refresh', { refreshToken: user.refreshToken }, { 'x-client-platform': 'mobile' });
      expect(refresh.statusCode).toBeGreaterThanOrEqual(401);
      expect(await prisma.session.count({ where: { userId: user.userId, revokedAt: null } })).toBe(0);
      const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'user.block', entityId: user.userId } });
      expect(audit.after).toMatchObject({ status: 'BLOCKED', reason: 'Fraude au paiement' });

      expect((await postAs(boss, `/admin/users/${user.userId}/block`, { reason: 'Encore une fois' })).statusCode).toBe(409);
      expect((await postAs(boss, `/admin/users/${user.userId}/unblock`)).json().status).toBe('ACTIVE');
      expect((await postAs(boss, `/admin/users/${user.userId}/unblock`)).statusCode).toBe(409);
      const back = await post(t, '/auth/login', { email: user.email, password: user.password });
      expect(back.statusCode).toBe(200);
    });

    it('un administrateur ne peut bloquer ni lui-même ni un autre administrateur', async () => {
      const other = await makeAdmin();
      expect((await postAs(boss, `/admin/users/${boss.userId}/block`, { reason: 'Par erreur' })).statusCode).toBe(409);
      expect((await postAs(boss, `/admin/users/${other.userId}/block`, { reason: 'Pas autorisé' })).statusCode).toBe(409);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: other.userId } })).status).toBe('ACTIVE');
    });
  });

  // ───────────────────────── Commission et paramètres ─────────────────────────

  describe('commission', () => {
    let world: World;
    beforeAll(async () => {
      world = await createWorld(t);
    });
    const dueSlot = (n: number) => ({ date: dayIn(20 + n), hhmm: '14:00' });
    const reserve = (user: Signup, n: number) =>
      t.app.inject({
        method: 'POST',
        url: '/api/v1/bookings',
        payload: { fieldId: world.small.id, startsAt: new Date(`${dueSlot(n).date}T13:00:00.000Z`).toISOString() },
        headers: { ...as(user), 'idempotency-key': randomUUID() },
      });

    it('taux global initial : 1 % ; vue d’ensemble', async () => {
      const overview = (await getAs(boss, '/admin/commission')).json();
      expect(overview.global).toMatchObject({ scope: 'GLOBAL', rateBps: 100, fixedMinor: 0, isActive: true, validTo: null });
      expect(overview.history.length).toBeGreaterThanOrEqual(1);
    });

    it('un nouveau taux global ferme l’ancien (historique conservé) et ne touche pas aux réservations déjà faites', async () => {
      const player = await newPlayer(t);
      const before = await reserve(player, 1);
      expect(before.statusCode).toBe(201);
      const beforeRow = await prisma.booking.findUniqueOrThrow({ where: { id: before.json().id } });
      expect(beforeRow.commissionRateBps).toBe(100);

      const res = await put(t, '/admin/commission/global', { rateBps: 250, fixedMinor: 0, reason: 'Nouveau barème' }, boss.accessToken);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ scope: 'GLOBAL', rateBps: 250, isActive: true });

      const actives = await prisma.commissionRule.findMany({ where: { scope: 'GLOBAL', isActive: true } });
      expect(actives).toHaveLength(1);
      const closed = await prisma.commissionRule.findMany({ where: { scope: 'GLOBAL', isActive: false } });
      expect(closed.length).toBeGreaterThanOrEqual(1);
      expect(closed.every((r) => r.validTo !== null)).toBe(true);

      const after = await reserve(player, 2);
      const afterRow = await prisma.booking.findUniqueOrThrow({ where: { id: after.json().id } });
      expect(afterRow).toMatchObject({ commissionRateBps: 250, commissionMinor: Math.floor((afterRow.basePriceMinor * 250) / 10_000) });
      expect((await prisma.booking.findUniqueOrThrow({ where: { id: before.json().id } })).commissionRateBps).toBe(100); // figé
      const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'commission.update_global' }, orderBy: { createdAt: 'desc' } });
      expect(audit).toMatchObject({ before: { rateBps: 100 }, after: { rateBps: 250, reason: 'Nouveau barème' } });
      await put(t, '/admin/commission/global', { rateBps: 100 }, boss.accessToken); // retour au barème initial
    });

    it('taux propre à un complexe : prioritaire sur le global ; le retirer ramène au global', async () => {
      const player = await newPlayer(t);
      const res = await put(t, `/admin/commission/venues/${world.venue.id}`, { rateBps: 0, fixedMinor: 150 }, boss.accessToken);
      expect(res.json()).toMatchObject({ scope: 'VENUE', venueId: world.venue.id, rateBps: 0, fixedMinor: 150 });
      const listed = (await getAs(boss, `/admin/venues/${world.venue.id}`)).json();
      expect(listed.commission).toEqual({ rateBps: 0, fixedMinor: 150, scope: 'VENUE' });

      const own = await reserve(player, 3);
      expect(await prisma.booking.findUniqueOrThrow({ where: { id: own.json().id } })).toMatchObject({ commissionRateBps: 0, commissionFixedMinor: 150, commissionMinor: 150 });

      expect((await del(t, `/admin/commission/venues/${world.venue.id}`, boss.accessToken)).statusCode).toBe(204);
      expect((await del(t, `/admin/commission/venues/${world.venue.id}`, boss.accessToken)).statusCode).toBe(404);
      expect((await getAs(boss, `/admin/venues/${world.venue.id}`)).json().commission).toMatchObject({ scope: 'GLOBAL', rateBps: 100 });
      const back = await reserve(player, 4);
      expect((await prisma.booking.findUniqueOrThrow({ where: { id: back.json().id } })).commissionRateBps).toBe(100);
      expect((await put(t, `/admin/commission/venues/${randomUUID()}`, { rateBps: 50 }, boss.accessToken)).statusCode).toBe(404);
    });

    it('refuse les valeurs aberrantes (plus de 30 %, négatif, décimal) et les champs inconnus', async () => {
      for (const bad of [{ rateBps: 3001 }, { rateBps: 10_000 }, { rateBps: -1 }, { rateBps: 1.5 }, { rateBps: '100' }, {}, { rateBps: 100, fixedMinor: -5 }, { rateBps: 100, fixedMinor: 1_000_000 }, { rateBps: 100, scope: 'VENUE' }]) {
        expect((await put(t, '/admin/commission/global', bad, boss.accessToken)).statusCode, JSON.stringify(bad)).toBe(400);
      }
      expect((await put(t, '/admin/commission/global', { rateBps: 3000 }, boss.accessToken)).statusCode).toBe(200);
      await put(t, '/admin/commission/global', { rateBps: 100 }, boss.accessToken);
    });

    it('CONCURRENCE : 6 changements simultanés → une seule règle globale active', async () => {
      await Promise.all([200, 300, 400, 500, 600, 700].map((rateBps) => put(t, '/admin/commission/global', { rateBps }, boss.accessToken)));
      expect(await prisma.commissionRule.count({ where: { scope: 'GLOBAL', isActive: true } })).toBe(1);
      await put(t, '/admin/commission/global', { rateBps: 100 }, boss.accessToken);
      expect((await getAs(boss, '/admin/commission')).json().global.rateBps).toBe(100);
    });
  });

  describe('paramètres de la plateforme', () => {
    it('liste, modifie avec validation par clé, audite, et la nouvelle valeur est utilisée', async () => {
      const list = (await getAs(boss, '/admin/settings')).json();
      expect(list.map((s: { key: string }) => s.key)).toEqual(expect.arrayContaining(['booking.hold_minutes', 'booking.default_deposit']));

      const res = await put(t, '/admin/settings/booking.hold_minutes', { value: 7 }, boss.accessToken);
      expect(res.json()).toEqual({ key: 'booking.hold_minutes', value: 7 });
      t.app.get(SettingsService).invalidate();
      expect(await t.app.get(SettingsService).getInt('booking.hold_minutes', 10)).toBe(7);
      const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'setting.update' }, orderBy: { createdAt: 'desc' } });
      expect(audit).toMatchObject({ before: { key: 'booking.hold_minutes', value: 10 }, after: { key: 'booking.hold_minutes', value: 7 } });

      const world = await createWorld(t);
      const player = await newPlayer(t);
      const quote = await postAs(player, '/bookings/quote', { fieldId: world.small.id, startsAt: new Date(`${dayIn(9)}T13:00:00.000Z`).toISOString() });
      expect(quote.json().holdMinutes).toBe(7);
      await put(t, '/admin/settings/booking.hold_minutes', { value: 10 }, boss.accessToken);
    });

    it('refuse une clé inconnue, une valeur hors bornes ou d’un mauvais type', async () => {
      expect((await put(t, '/admin/settings/booking.nope', { value: 1 }, boss.accessToken)).statusCode).toBe(404);
      expect((await put(t, '/admin/settings/__proto__', { value: 1 }, boss.accessToken)).statusCode).toBe(404);
      for (const value of [0, 61, -3, 1.5, 'dix', null, {}]) {
        expect((await put(t, '/admin/settings/booking.hold_minutes', { value }, boss.accessToken)).statusCode, String(value)).toBe(400);
      }
      expect((await put(t, '/admin/settings/booking.default_deposit', { value: { mode: 'PERCENT', rateBps: 50_000, fixedMinor: 0, minMinor: 0 } }, boss.accessToken)).statusCode).toBe(400);
      expect((await put(t, '/admin/settings/booking.default_cancellation_policy', { value: { freeUntilHoursBefore: 12, refundDeposit: true } }, boss.accessToken)).statusCode).toBe(200);
      await put(t, '/admin/settings/booking.default_cancellation_policy', { value: { freeUntilHoursBefore: 24, refundDeposit: false } }, boss.accessToken);
      expect((await put(t, '/admin/settings/booking.hold_minutes', { value: 5, extra: true }, boss.accessToken)).statusCode).toBe(400);
    });
  });

  // ───────────────────────── Avis ─────────────────────────

  describe('modération des avis', () => {
    it('masquer un avis le retire de la page publique et recalcule la note ; le rétablir la remet', async () => {
      const world = await createWorld(t);
      const ids: string[] = [];
      for (const rating of [5, 1]) {
        const user = await newPlayer(t);
        const booking = await book({ fieldId: world.small.id, venueId: world.venue.id }, dayIn(30 + ids.length), '15:00', { status: 'COMPLETED', userId: user.userId });
        ids.push((await postAs(user, `/bookings/${booking.id}/review`, { rating, comment: `Avis ${rating}` })).json().id);
      }
      expect(await prisma.venue.findUniqueOrThrow({ where: { id: world.venue.id } })).toMatchObject({ ratingAvg: 3, ratingCount: 2 });

      expect((await postAs(boss, `/admin/reviews/${ids[1]}/hide`, {})).statusCode).toBe(400); // motif obligatoire
      expect((await postAs(boss, `/admin/reviews/${ids[1]}/hide`, { reason: 'Propos injurieux' })).statusCode).toBe(204);
      expect(await prisma.venue.findUniqueOrThrow({ where: { id: world.venue.id } })).toMatchObject({ ratingAvg: 5, ratingCount: 1 });
      expect((await getAs(null, `/venues/${world.venue.slug}/reviews`)).json().items.map((r: { rating: number }) => r.rating)).toEqual([5]);
      expect((await postAs(boss, `/admin/reviews/${ids[1]}/hide`, { reason: 'Encore' })).statusCode).toBe(409);
      const hidden = (await getAs(boss, `/admin/reviews?hidden=true&venueId=${world.venue.id}`)).json().items;
      expect(hidden.map((r: { id: string }) => r.id)).toEqual([ids[1]]);

      expect((await postAs(boss, `/admin/reviews/${ids[1]}/unhide`, { reason: 'Réexamen' })).statusCode).toBe(204);
      expect(await prisma.venue.findUniqueOrThrow({ where: { id: world.venue.id } })).toMatchObject({ ratingAvg: 3, ratingCount: 2 });
      expect((await postAs(boss, `/admin/reviews/${ids[1]}/unhide`, { reason: 'Déjà visible' })).statusCode).toBe(409);
      expect((await postAs(boss, `/admin/reviews/${randomUUID()}/hide`, { reason: 'Inconnu' })).statusCode).toBe(404);
      expect(await prisma.auditLog.count({ where: { action: { in: ['review.hide', 'review.unhide'] }, entityId: ids[1] } })).toBe(2);
    });
  });

  // ───────────────────────── Statistiques ─────────────────────────

  describe('statistiques', () => {
    it('administration : chiffres exacts sur une période, jours sans réservation à zéro, top des complexes', async () => {
      const world = await createWorld(t);
      const ids = { fieldId: world.small.id, venueId: world.venue.id };
      const d0 = dayIn(100);
      const d2 = dayIn(102);
      await book(ids, d0, '18:00'); // CONFIRMED 4000
      await book(ids, d0, '19:00', { status: 'COMPLETED' });
      await book(ids, d2, '18:00', { status: 'CANCELLED' });
      await book(ids, d2, '19:00', { status: 'NO_SHOW' });
      await book(ids, d2, '20:00', { type: 'BLOCK' });

      const s = (await getAs(boss, `/admin/stats?from=${d0}&to=${d2}`)).json();
      expect(s.bookings).toMatchObject({ total: 4, confirmed: 1, completed: 1, cancelled: 1, noShow: 1 });
      expect(s.grossMinor).toBe(8000);
      expect(s.commissionMinor).toBe(80);
      expect(s.daily).toEqual([
        { date: d0, bookings: 2, revenueMinor: 8000 },
        { date: dayIn(101), bookings: 0, revenueMinor: 0 },
        { date: d2, bookings: 0, revenueMinor: 0 },
      ]);
      expect(s.topVenues[0]).toMatchObject({ venueId: world.venue.id, bookings: 2, grossMinor: 8000 });
      expect(s.venues.total).toBeGreaterThanOrEqual(1);
      expect(s.users.total).toBeGreaterThanOrEqual(1);
    });

    it('valide la période (ordre, durée maximale, format)', async () => {
      for (const qs of ['from=2027-02-01&to=2027-01-01', 'from=2027-01-01&to=2028-06-01', 'from=nope&to=2027-01-01', 'from=2027-01-01', '']) {
        expect((await getAs(boss, `/admin/stats?${qs}`)).statusCode, qs).toBe(400);
      }
    });

    it('complexe : revenus, commission, part du complexe, heures, no-shows, par heure et par terrain — réservé aux gérants', async () => {
      const world = await createWorld(t);
      const manager = await newPlayer(t);
      await prisma.venueStaff.create({ data: { venueId: world.venue.id, userId: manager.userId, role: 'MANAGER' } });
      const second = await prisma.field.create({ data: { venueId: world.venue.id, name: 'Terrain B', capacity: 10 } });
      const d = dayIn(110);
      await book({ fieldId: world.small.id, venueId: world.venue.id }, d, '18:00');
      await book({ fieldId: world.small.id, venueId: world.venue.id }, d, '19:00');
      await book({ fieldId: second.id, venueId: world.venue.id }, d, '18:00', { status: 'COMPLETED' });
      await book({ fieldId: second.id, venueId: world.venue.id }, d, '19:00', { status: 'NO_SHOW' });
      await book({ fieldId: second.id, venueId: world.venue.id }, d, '20:00', { status: 'CANCELLED' });
      await book({ fieldId: second.id, venueId: world.venue.id }, d, '21:00', { type: 'BLOCK' });

      const res = await getAs(manager, `/manage/venues/${world.venue.id}/stats?from=${d}&to=${d}`);
      expect(res.statusCode).toBe(200);
      const s = res.json();
      expect(s.bookings).toEqual({ total: 5, confirmed: 2, completed: 1, cancelled: 1, noShow: 1 });
      expect(s).toMatchObject({ grossMinor: 12_000, commissionMinor: 120, netMinor: 11_880, bookedHours: 3, noShowRate: 0.5 });
      expect(s.onlineMinor + s.onSiteMinor).toBe(12_000 - 0); // acompte (commission) + solde = prix
      expect(s.byHour).toEqual([{ hour: 18, bookings: 2 }, { hour: 19, bookings: 1 }]);
      expect(s.byField.map((f: { name: string; bookings: number }) => [f.name, f.bookings]).sort()).toEqual([[world.small.name, 2], ['Terrain B', 1]].sort());
      expect(s.daily).toEqual([{ date: d, bookings: 3, revenueMinor: 12_000 }]);

      expect((await getAs(world.staff, `/manage/venues/${world.venue.id}/stats?from=${d}&to=${d}`)).statusCode).toBe(403);
      expect((await getAs(world.outsider, `/manage/venues/${world.venue.id}/stats?from=${d}&to=${d}`)).statusCode).toBe(404);
      expect((await getAs(boss, `/manage/venues/${world.venue.id}/stats?from=${d}&to=${d}`)).statusCode).toBe(200);
      expect((await getAs(null, `/manage/venues/${world.venue.id}/stats?from=${d}&to=${d}`)).statusCode).toBe(401);
      expect((await getAs(manager, `/manage/venues/${world.venue.id}/stats?from=${d}`)).statusCode).toBe(400);
    });

    it('un gérant ne voit JAMAIS les chiffres d’un autre complexe', async () => {
      const mine = await createWorld(t);
      const theirs = await createWorld(t);
      const owner = await newPlayer(t);
      await prisma.venueStaff.create({ data: { venueId: mine.venue.id, userId: owner.userId, role: 'OWNER' } });
      const d = dayIn(111);
      await book({ fieldId: theirs.small.id, venueId: theirs.venue.id }, d, '18:00');
      expect((await getAs(owner, `/manage/venues/${theirs.venue.id}/stats?from=${d}&to=${d}`)).statusCode).toBe(404);
      expect((await getAs(owner, `/manage/venues/${mine.venue.id}/stats?from=${d}&to=${d}`)).json().grossMinor).toBe(0);
    });

    it('joueur : mon tableau de bord', async () => {
      const world = await createWorld(t);
      const user = await newPlayer(t);
      expect((await getAs(user, '/me/stats')).json()).toEqual({ matchesPlayed: 0, noShowCount: 0, lateCancelCount: 0, reliabilityScore: 100, upcomingBookings: 0, upcomingMatches: 0, teams: 0, unreadNotifications: 0 });

      await book({ fieldId: world.small.id, venueId: world.venue.id }, dayIn(120), '18:00', { userId: user.userId });
      await book({ fieldId: world.small.id, venueId: world.venue.id }, dayIn(121), '18:00', { userId: user.userId, status: 'CANCELLED' });
      await post(t, '/teams', { name: `Stats ${randomUUID().slice(0, 6)}` }, as(user));
      await prisma.playerStats.upsert({ where: { userId: user.userId }, create: { userId: user.userId, matchesPlayed: 4, noShowCount: 1, reliabilityScore: 90 }, update: { matchesPlayed: 4, noShowCount: 1, reliabilityScore: 90 } });
      const stats = (await getAs(user, '/me/stats')).json();
      expect(stats).toMatchObject({ matchesPlayed: 4, noShowCount: 1, reliabilityScore: 90, upcomingBookings: 1, teams: 1 });
      expect((await getAs(null, '/me/stats')).statusCode).toBe(401);
    });
  });

  // ───────────────────────── Audit ─────────────────────────

  describe('journal d’audit', () => {
    it('filtrable par action, entité, acteur, période ; paginé ; lecture seule', async () => {
      const { venue } = await pendingVenue();
      await postAs(boss, `/admin/venues/${venue.id}/approve`, {});
      await postAs(boss, `/admin/venues/${venue.id}/suspend`, { reason: 'Contrôle sanitaire' });

      const byEntity = (await getAs(boss, `/admin/audit-logs?entityId=${venue.id}`)).json();
      expect(byEntity.items.map((a: { action: string }) => a.action)).toEqual(['venue.suspend', 'venue.approve']);
      expect(byEntity.items[0]).toMatchObject({ actorId: boss.userId, actorRole: 'ADMIN', entityType: 'Venue', after: { status: 'SUSPENDED', reason: 'Contrôle sanitaire' } });
      expect((await getAs(boss, `/admin/audit-logs?action=venue.&actorId=${boss.userId}`)).json().items.length).toBeGreaterThanOrEqual(2);
      expect((await getAs(boss, `/admin/audit-logs?entityId=${venue.id}&limit=1`)).json().nextCursor).not.toBeNull();
      expect((await getAs(boss, `/admin/audit-logs?from=${dayIn(5)}`)).json().items).toEqual([]);
      expect((await getAs(boss, '/admin/audit-logs?entityId=pas-un-uuid')).statusCode).toBe(400);
      expect(JSON.stringify(byEntity)).not.toMatch(/password|token/i);
      for (const method of ['PUT', 'PATCH', 'DELETE'] as const) {
        const res = await t.app.inject({ method, url: `/api/v1/admin/audit-logs/${byEntity.items[0].id}`, headers: as(boss) });
        expect(res.statusCode).toBe(404);
      }
    });
  });

  // ───────────────────────── Personnel d'un complexe ─────────────────────────

  describe('personnel d’un complexe', () => {
    const staffUrl = (venueId: string, userId = '') => `/manage/venues/${venueId}/staff${userId ? `/${userId}` : ''}`;
    const patchStaff = (u: Signup, venueId: string, userId: string, role: string) =>
      t.app.inject({ method: 'PATCH', url: `/api/v1${staffUrl(venueId, userId)}`, payload: { role }, headers: as(u) });
    const removeStaff = (u: Signup, venueId: string, userId: string) => del(t, staffUrl(venueId, userId), u.accessToken);

    it('le propriétaire ajoute, promeut et retire ; chaque action est auditée', async () => {
      const { venue, owner } = await pendingVenue();
      const recruit = await newPlayer(t);

      const added = await postAs(owner, staffUrl(venue.id), { email: recruit.email, role: 'MANAGER' });
      expect(added.statusCode).toBe(201);
      expect(added.json()).toMatchObject({ userId: recruit.userId, role: 'MANAGER', email: recruit.email });
      expect((await getAs(recruit, `/manage/venues/${venue.id}`)).statusCode).toBe(200); // accès immédiat

      expect((await patchStaff(owner, venue.id, recruit.userId, 'OWNER')).json().role).toBe('OWNER');
      expect((await removeStaff(owner, venue.id, recruit.userId)).statusCode).toBe(204);
      expect((await getAs(recruit, `/manage/venues/${venue.id}`)).statusCode).toBe(404); // accès retiré immédiatement
      expect(await prisma.auditLog.count({ where: { entityId: venue.id, action: { in: ['venue.staff_add', 'venue.staff_role', 'venue.staff_remove'] } } })).toBe(3);
    });

    it('rôles : un gérant peut lister mais pas modifier ; un simple membre ne liste pas ; un étranger n’existe pas (404)', async () => {
      const { venue, owner, manager, staff } = await pendingVenue();
      const stranger = await newPlayer(t);
      const list = (await getAs(manager, staffUrl(venue.id))).json();
      expect(list.map((m: { role: string }) => m.role)).toEqual(['OWNER', 'MANAGER', 'STAFF']);
      expect(JSON.stringify(list)).not.toMatch(/passwordHash|phone/i);
      expect((await getAs(staff, staffUrl(venue.id))).statusCode).toBe(403);
      expect((await getAs(stranger, staffUrl(venue.id))).statusCode).toBe(404);

      expect((await postAs(manager, staffUrl(venue.id), { email: stranger.email })).statusCode).toBe(403);
      expect((await patchStaff(manager, venue.id, staff.userId, 'MANAGER')).statusCode).toBe(403);
      expect((await removeStaff(manager, venue.id, staff.userId)).statusCode).toBe(403);
      expect((await postAs(stranger, staffUrl(venue.id), { email: stranger.email, role: 'OWNER' })).statusCode).toBe(404); // pas d'auto-promotion
      expect((await removeStaff(owner, venue.id, randomUUID())).statusCode).toBe(404);
    });

    it('refuse : compte inconnu, bloqué, déjà membre, rôle invalide, champs en trop', async () => {
      const { venue, owner, staff } = await pendingVenue();
      const blocked = await newPlayer(t);
      await prisma.user.update({ where: { id: blocked.userId }, data: { status: 'BLOCKED' } });
      expect((await postAs(owner, staffUrl(venue.id), { email: 'personne@example.com' })).statusCode).toBe(404);
      expect((await postAs(owner, staffUrl(venue.id), { email: blocked.email })).statusCode).toBe(404);
      const dup = await postAs(owner, staffUrl(venue.id), { email: staff.email });
      expect(dup.statusCode).toBe(409);
      expect(dup.json().error.code).toBe('ALREADY_JOINED');
      expect((await postAs(owner, staffUrl(venue.id), { email: staff.email, role: 'GOD' })).statusCode).toBe(400);
      expect((await postAs(owner, staffUrl(venue.id), { email: staff.email, userId: randomUUID() })).statusCode).toBe(400);
    });

    it('un complexe garde toujours un propriétaire : ni rétrogradation, ni départ du dernier ; CONCURRENCE sur deux propriétaires', async () => {
      const { venue, owner } = await pendingVenue();
      expect((await patchStaff(owner, venue.id, owner.userId, 'MANAGER')).statusCode).toBe(409);
      expect((await removeStaff(owner, venue.id, owner.userId)).statusCode).toBe(409);

      const partner = await newPlayer(t);
      await postAs(owner, staffUrl(venue.id), { email: partner.email, role: 'OWNER' });
      // Les deux propriétaires se retirent EN MÊME TEMPS : un seul y parvient.
      const results = await Promise.all([removeStaff(owner, venue.id, owner.userId), removeStaff(partner, venue.id, partner.userId)]);
      expect(results.filter((r) => r.statusCode === 204)).toHaveLength(1);
      expect(await prisma.venueStaff.count({ where: { venueId: venue.id, role: 'OWNER' } })).toBe(1);
    });

    it('chacun peut quitter le complexe de lui-même', async () => {
      const { venue, staff, manager } = await pendingVenue();
      expect((await removeStaff(staff, venue.id, staff.userId)).statusCode).toBe(204);
      expect((await removeStaff(manager, venue.id, manager.userId)).statusCode).toBe(204);
      expect((await getAs(staff, `/manage/venues/${venue.id}`)).statusCode).toBe(404);
    });
  });
});
