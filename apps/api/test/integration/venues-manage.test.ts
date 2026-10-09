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
} from './app-helper.js';
import { prisma, resetDb } from './helpers.js';
import { book, createVenueWithFields, dayIn, slotAt } from './venue-fixtures.js';

const DATE = dayIn(7);

describe('espace complexe (back-office)', () => {
  let t: TestApp;

  beforeAll(async () => {
    await resetDb();
    t = await createTestApp();
  });
  afterAll(() => t.close());
  beforeEach(() => t.rateLimits.reset());

  // ───────────────────────── Outils ─────────────────────────

  const put = (url: string, payload: unknown, token: string) =>
    t.app.inject({
      method: 'PUT',
      url: `/api/v1${url}`,
      payload: payload as object,
      headers: bearer(token),
    });
  const authed = (user: Signup) => user.accessToken;

  /** Utilisateur dont l'email est vérifié (nécessaire pour déclarer un complexe). */
  async function verifiedUser(): Promise<Signup> {
    const user = await signup(t);
    await post(t, '/auth/verify-email', { token: t.mailer.lastToken(user.email) });
    return user;
  }

  const venueBody = (overrides: Record<string, unknown> = {}) => ({
    name: 'Five Alger Centre',
    city: 'Alger',
    district: 'Hydra',
    address: '12 rue Didouche Mourad',
    ...overrides,
  });

  /** Un complexe avec un terrain et un membre de chaque rôle. */
  async function venueWithTeam() {
    const { venue, fields } = await createVenueWithFields({ name: 'Équipe Test' }, [
      { name: 'Terrain 1' },
    ]);
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
    return { venue, field: fields[0]!, owner, manager, staff, outsider };
  }

  // ───────────────────────── Création ─────────────────────────

  describe('POST /manage/venues', () => {
    it('exige un compte authentifié ET un email vérifié', async () => {
      expect((await post(t, '/manage/venues', venueBody())).statusCode).toBe(401);

      const unverified = await signup(t);
      const res = await post(t, '/manage/venues', venueBody(), bearer(unverified.accessToken));
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('EMAIL_NOT_VERIFIED');
    });

    it('crée le complexe EN ATTENTE, le créateur devient propriétaire, un audit est enregistré', async () => {
      const user = await verifiedUser();
      const res = await post(
        t,
        '/manage/venues',
        venueBody({ phone: '0550 12 34 56', amenities: ['Parking'] }),
        bearer(authed(user)),
      );

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body).toMatchObject({
        name: 'Five Alger Centre',
        slug: 'five-alger-centre',
        status: 'PENDING',
        timezone: 'Africa/Algiers',
        phone: '+213550123456',
        amenities: ['parking'],
        role: 'OWNER',
        fields: [],
        openingHours: [],
      });

      const staff = await prisma.venueStaff.findFirst({ where: { venueId: body.id } });
      expect(staff).toMatchObject({ userId: user.userId, role: 'OWNER' });
      expect(
        await prisma.auditLog.count({
          where: { action: 'venue.create', entityId: body.id, actorId: user.userId },
        }),
      ).toBe(1);
    });

    it('le complexe n’est PAS public tant qu’il n’est pas approuvé', async () => {
      const user = await verifiedUser();
      const body = (
        await post(
          t,
          '/manage/venues',
          venueBody({ name: 'Invisible Avant Approbation' }),
          bearer(authed(user)),
        )
      ).json();
      expect((await get(t, `/venues/${body.slug}`)).statusCode).toBe(404);

      await prisma.venue.update({ where: { id: body.id }, data: { status: 'APPROVED' } });
      expect((await get(t, `/venues/${body.slug}`)).statusCode).toBe(200);
    });

    it('REFUSE de choisir son propre statut ou son adresse web (assignation de masse)', async () => {
      const user = await verifiedUser();
      for (const field of ['status', 'slug', 'ratingAvg', 'depositPolicy', 'id']) {
        const res = await post(
          t,
          '/manage/venues',
          venueBody({ [field]: field === 'status' ? 'APPROVED' : 'x' }),
          bearer(authed(user)),
        );
        expect(res.statusCode, field).toBe(400);
      }
    });

    it('génère une adresse web unique quand deux complexes portent le même nom', async () => {
      const [a, b] = await Promise.all([verifiedUser(), verifiedUser()]);
      const first = (
        await post(t, '/manage/venues', venueBody({ name: 'Doublon FC' }), bearer(authed(a)))
      ).json();
      const second = (
        await post(t, '/manage/venues', venueBody({ name: 'Doublon FC' }), bearer(authed(b)))
      ).json();
      expect(first.slug).toBe('doublon-fc');
      expect(second.slug).toMatch(/^doublon-fc-[0-9a-f]{6}$/);
    });

    it('valide les données (coordonnées incohérentes, fuseau inconnu, nom trop court)', async () => {
      const user = await verifiedUser();
      for (const bad of [
        { latitude: 36.7 },
        { timezone: 'Mars/Olympus' },
        { name: 'A' },
        { phone: 'abc' },
      ]) {
        const res = await post(t, '/manage/venues', venueBody(bad), bearer(authed(user)));
        expect(res.statusCode).toBe(400);
      }
    });

    it('limite la création à 5 complexes par jour et par utilisateur', async () => {
      const user = await verifiedUser();
      for (let i = 0; i < 5; i++) {
        expect(
          (await post(t, '/manage/venues', venueBody({ name: `Spam ${i}` }), bearer(authed(user))))
            .statusCode,
        ).toBe(201);
      }
      expect(
        (await post(t, '/manage/venues', venueBody({ name: 'Spam 6' }), bearer(authed(user))))
          .statusCode,
      ).toBe(429);
    });
  });

  describe('GET /manage/venues (mes complexes)', () => {
    it('liste uniquement MES complexes avec mon rôle', async () => {
      const { venue, owner, staff, outsider } = await venueWithTeam();
      const mine = (await get(t, '/manage/venues', owner.accessToken)).json();
      expect(mine).toEqual([
        expect.objectContaining({
          id: venue.id,
          role: 'OWNER',
          fieldsCount: 1,
          status: 'APPROVED',
        }),
      ]);
      expect((await get(t, '/manage/venues', staff.accessToken)).json()[0].role).toBe('STAFF');
      expect((await get(t, '/manage/venues', outsider.accessToken)).json()).toEqual([]);
    });
  });

  // ───────────────────────── Autorisations ─────────────────────────

  describe('autorisations par rôle', () => {
    it('un NON-membre reçoit 404 sur toutes les routes (on ne confirme même pas l’existence du complexe)', async () => {
      const { venue, field, outsider } = await venueWithTeam();
      const base = `/manage/venues/${venue.id}`;
      const token = outsider.accessToken;

      expect((await get(t, base, token)).statusCode).toBe(404);
      expect((await patch(t, base, { district: 'X' }, token)).statusCode).toBe(404);
      expect((await get(t, `${base}/availability?date=${DATE}`, token)).statusCode).toBe(404);
      expect(
        (await post(t, `${base}/fields`, { name: 'Pirate', capacity: 10 }, bearer(token)))
          .statusCode,
      ).toBe(404);
      expect(
        (await patch(t, `${base}/fields/${field.id}`, { name: 'Pirate' }, token)).statusCode,
      ).toBe(404);
      expect((await del(t, `${base}/fields/${field.id}`, token)).statusCode).toBe(404);
      expect((await put(`${base}/opening-hours`, { days: [] }, token)).statusCode).toBe(404);
      expect((await get(t, `${base}/fields/${field.id}/pricing-rules`, token)).statusCode).toBe(
        404,
      );
      expect(
        (
          await post(
            t,
            `${base}/fields/${field.id}/pricing-rules`,
            { weekdays: [1], from: '10:00', to: '12:00', priceMinor: 1 },
            bearer(token),
          )
        ).statusCode,
      ).toBe(404);
    });

    it('sans jeton : 401 partout', async () => {
      const { venue } = await venueWithTeam();
      expect((await get(t, `/manage/venues/${venue.id}`)).statusCode).toBe(401);
      expect((await get(t, '/manage/venues')).statusCode).toBe(401);
    });

    it('le STAFF peut CONSULTER (fiche, calendrier, tarifs) mais pas MODIFIER (403)', async () => {
      const { venue, field, staff } = await venueWithTeam();
      const base = `/manage/venues/${venue.id}`;
      const token = staff.accessToken;

      expect((await get(t, base, token)).statusCode).toBe(200);
      expect((await get(t, `${base}/availability?date=${DATE}`, token)).statusCode).toBe(200);
      expect((await get(t, `${base}/fields/${field.id}/pricing-rules`, token)).statusCode).toBe(
        200,
      );

      for (const res of [
        await patch(t, base, { district: 'X' }, token),
        await post(t, `${base}/fields`, { name: 'Nouveau', capacity: 10 }, bearer(token)),
        await patch(t, `${base}/fields/${field.id}`, { name: 'Renommé' }, token),
        await del(t, `${base}/fields/${field.id}`, token),
        await put(`${base}/opening-hours`, { days: [] }, token),
        await post(
          t,
          `${base}/fields/${field.id}/pricing-rules`,
          { weekdays: [1], from: '10:00', to: '12:00', priceMinor: 100 },
          bearer(token),
        ),
      ]) {
        expect(res.statusCode).toBe(403);
        expect(res.json().error.code).toBe('FORBIDDEN');
      }
    });

    it('le MANAGER et le PROPRIÉTAIRE peuvent modifier', async () => {
      const { venue, manager, owner } = await venueWithTeam();
      for (const user of [manager, owner]) {
        const res = await patch(
          t,
          `/manage/venues/${venue.id}`,
          { description: `Modifié par ${user.userId}` },
          user.accessToken,
        );
        expect(res.statusCode).toBe(200);
      }
    });

    it('un administrateur de la plateforme accède à n’importe quel complexe', async () => {
      const { venue } = await venueWithTeam();
      const admin = await signup(t);
      await prisma.user.update({ where: { id: admin.userId }, data: { platformRole: 'ADMIN' } });
      const res = await get(t, `/manage/venues/${venue.id}`, admin.accessToken);
      expect(res.statusCode).toBe(200);
      expect(res.json().role).toBe('ADMIN');
    });

    it('un identifiant de terrain d’un AUTRE complexe donne 404, même avec un complexe dont on est propriétaire', async () => {
      const mine = await venueWithTeam();
      const other = await venueWithTeam();
      const base = `/manage/venues/${mine.venue.id}`;

      // Je suis propriétaire de `mine`, mais j'essaie d'atteindre le terrain de `other` via mon propre complexe.
      expect(
        (
          await patch(
            t,
            `${base}/fields/${other.field.id}`,
            { name: 'Vol' },
            mine.owner.accessToken,
          )
        ).statusCode,
      ).toBe(404);
      expect(
        (await del(t, `${base}/fields/${other.field.id}`, mine.owner.accessToken)).statusCode,
      ).toBe(404);
      expect(
        (await get(t, `${base}/fields/${other.field.id}/pricing-rules`, mine.owner.accessToken))
          .statusCode,
      ).toBe(404);
      expect(
        (
          await put(
            `${base}/fields/${other.field.id}/opening-hours`,
            { days: [] },
            mine.owner.accessToken,
          )
        ).statusCode,
      ).toBe(404);

      // Et rien n'a bougé chez l'autre.
      const untouched = await prisma.field.findUniqueOrThrow({ where: { id: other.field.id } });
      expect(untouched.isActive).toBe(true);
      expect(untouched.name).toBe('Terrain 1');
    });

    it('une règle de prix d’un autre terrain (même complexe) n’est pas modifiable via le mauvais terrain', async () => {
      const { venue, field, owner } = await venueWithTeam();
      const second = await prisma.field.create({ data: { venueId: venue.id, name: 'Terrain 2' } });
      const rule = await prisma.pricingRule.create({
        data: { fieldId: second.id, weekdays: [1], startMin: 600, endMin: 720, priceMinor: 5000 },
      });
      const res = await patch(
        t,
        `/manage/venues/${venue.id}/fields/${field.id}/pricing-rules/${rule.id}`,
        { priceMinor: 1 },
        owner.accessToken,
      );
      expect(res.statusCode).toBe(404);
      expect(
        (await prisma.pricingRule.findUniqueOrThrow({ where: { id: rule.id } })).priceMinor,
      ).toBe(5000);
    });

    it('refuse les identifiants mal formés', async () => {
      const { owner } = await venueWithTeam();
      expect((await get(t, '/manage/venues/pas-un-uuid', owner.accessToken)).statusCode).toBe(400);
    });
  });

  // ───────────────────────── Modification du complexe ─────────────────────────

  describe('PATCH /manage/venues/:id', () => {
    it('modifie les informations et la politique d’annulation, et journalise avant / après', async () => {
      const { venue, manager } = await venueWithTeam();
      const res = await patch(
        t,
        `/manage/venues/${venue.id}`,
        {
          district: 'Kouba',
          amenities: ['Douches', 'douches', 'Buvette'],
          cancellationPolicy: { freeUntilHoursBefore: 12, refundDeposit: true },
        },
        manager.accessToken,
      );
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        district: 'Kouba',
        amenities: ['douches', 'buvette'],
        cancellationPolicy: { freeUntilHoursBefore: 12, refundDeposit: true },
      });

      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { action: 'venue.update', entityId: venue.id },
      });
      expect(audit.actorId).toBe(manager.userId);
      expect(audit.before).toMatchObject({ district: null });
      expect(audit.after).toMatchObject({ district: 'Kouba' });
    });

    it('peut retirer la politique d’annulation (null) ; refuse fuseau, statut et politique d’acompte', async () => {
      const { venue, owner } = await venueWithTeam();
      await patch(
        t,
        `/manage/venues/${venue.id}`,
        { cancellationPolicy: { freeUntilHoursBefore: 1, refundDeposit: false } },
        owner.accessToken,
      );
      const cleared = await patch(
        t,
        `/manage/venues/${venue.id}`,
        { cancellationPolicy: null },
        owner.accessToken,
      );
      expect(cleared.json().cancellationPolicy).toBeNull();

      for (const field of ['timezone', 'status', 'depositPolicy', 'slug']) {
        const res = await patch(
          t,
          `/manage/venues/${venue.id}`,
          { [field]: 'x' },
          owner.accessToken,
        );
        expect(res.statusCode, field).toBe(400);
      }
      const row = await prisma.venue.findUniqueOrThrow({ where: { id: venue.id } });
      expect(row.status).toBe('APPROVED');
    });

    it('refuse une requête vide', async () => {
      const { venue, owner } = await venueWithTeam();
      expect((await patch(t, `/manage/venues/${venue.id}`, {}, owner.accessToken)).statusCode).toBe(
        400,
      );
    });
  });

  // ───────────────────────── Terrains ─────────────────────────

  describe('terrains', () => {
    it('ajoute un terrain avec ses caractéristiques, valeurs par défaut incluses', async () => {
      const { venue, manager } = await venueWithTeam();
      const res = await post(
        t,
        `/manage/venues/${venue.id}/fields`,
        { name: 'Terrain Central', capacity: 14, covered: true, dimensions: '40 x 20 m' },
        bearer(manager.accessToken),
      );
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({
        name: 'Terrain Central',
        capacity: 14,
        covered: true,
        lighting: true,
        surface: 'ARTIFICIAL_TURF',
        slotDurationMin: 60,
        isActive: true,
        pricingRules: [],
        priceFromMinor: null,
      });
    });

    it('refuse une capacité hors de 10–16 et un nom déjà pris dans le complexe (409), mais l’accepte dans un autre', async () => {
      const { venue, manager } = await venueWithTeam();
      const base = `/manage/venues/${venue.id}/fields`;
      expect(
        (await post(t, base, { name: 'Trop petit', capacity: 8 }, bearer(manager.accessToken)))
          .statusCode,
      ).toBe(400);
      expect(
        (await post(t, base, { name: 'Trop grand', capacity: 20 }, bearer(manager.accessToken)))
          .statusCode,
      ).toBe(400);

      const duplicate = await post(
        t,
        base,
        { name: 'Terrain 1', capacity: 10 },
        bearer(manager.accessToken),
      );
      expect(duplicate.statusCode).toBe(409);
      expect(duplicate.json().error.code).toBe('CONFLICT');

      const other = await venueWithTeam();
      expect(
        (
          await post(
            t,
            `/manage/venues/${other.venue.id}/fields`,
            { name: 'Terrain Central', capacity: 10 },
            bearer(other.manager.accessToken),
          )
        ).statusCode,
      ).toBe(201);
    });

    it('REFUSE de rattacher un terrain à un autre complexe via le corps de la requête', async () => {
      const { venue, manager } = await venueWithTeam();
      const other = await venueWithTeam();
      const res = await post(
        t,
        `/manage/venues/${venue.id}/fields`,
        { name: 'Intrus', capacity: 10, venueId: other.venue.id },
        bearer(manager.accessToken),
      );
      expect(res.statusCode).toBe(400);
    });

    it('modifie un terrain et journalise', async () => {
      const { venue, field, manager } = await venueWithTeam();
      const res = await patch(
        t,
        `/manage/venues/${venue.id}/fields/${field.id}`,
        { name: 'Terrain Premium', capacity: 16, lighting: false },
        manager.accessToken,
      );
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ name: 'Terrain Premium', capacity: 16, lighting: false });
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { action: 'field.update', entityId: field.id },
      });
      expect(audit.before).toMatchObject({ name: 'Terrain 1', capacity: 10 });
    });

    it('refuse de renommer vers un nom existant (409)', async () => {
      const { venue, field, manager } = await venueWithTeam();
      await prisma.field.create({ data: { venueId: venue.id, name: 'Occupé' } });
      const res = await patch(
        t,
        `/manage/venues/${venue.id}/fields/${field.id}`,
        { name: 'Occupé' },
        manager.accessToken,
      );
      expect(res.statusCode).toBe(409);
    });

    it('la durée des créneaux ne peut pas changer s’il existe des réservations à venir (409)', async () => {
      const { venue, field, manager } = await venueWithTeam();
      const url = `/manage/venues/${venue.id}/fields/${field.id}`;
      // Sans réservation : modifiable
      expect((await patch(t, url, { slotDurationMin: 90 }, manager.accessToken)).statusCode).toBe(
        200,
      );
      expect((await patch(t, url, { slotDurationMin: 60 }, manager.accessToken)).statusCode).toBe(
        200,
      );

      await book({ fieldId: field.id, venueId: venue.id }, DATE, '20:00');
      const blocked = await patch(t, url, { slotDurationMin: 90 }, manager.accessToken);
      expect(blocked.statusCode).toBe(409);
      expect(
        (await prisma.field.findUniqueOrThrow({ where: { id: field.id } })).slotDurationMin,
      ).toBe(60);
      // Mais un autre champ reste modifiable
      expect(
        (await patch(t, url, { description: 'Gazon neuf' }, manager.accessToken)).statusCode,
      ).toBe(200);
    });

    it('« supprimer » désactive : le terrain disparaît du public, l’historique des réservations est conservé, il peut être réactivé', async () => {
      const { venue, field, manager } = await venueWithTeam();
      const url = `/manage/venues/${venue.id}/fields/${field.id}`;
      const booking = await book({ fieldId: field.id, venueId: venue.id }, DATE, '20:00');

      expect((await del(t, url, manager.accessToken)).statusCode).toBe(204);
      expect((await del(t, url, manager.accessToken)).statusCode).toBe(204); // idempotent

      const publicView = (await get(t, `/venues/${venue.slug}`)).json();
      expect(publicView.fields).toEqual([]);
      expect(await prisma.booking.findUnique({ where: { id: booking.id } })).not.toBeNull();
      expect(
        await prisma.auditLog.count({ where: { action: 'field.deactivate', entityId: field.id } }),
      ).toBe(2);

      const back = await patch(t, url, { isActive: true }, manager.accessToken);
      expect(back.json().isActive).toBe(true);
      expect((await get(t, `/venues/${venue.slug}`)).json().fields).toHaveLength(1);
    });
  });

  // ───────────────────────── Horaires ─────────────────────────

  describe('horaires d’ouverture', () => {
    it('définit les horaires du complexe ; les jours absents sont fermés ; la fiche publique les reflète', async () => {
      const { venue, manager } = await venueWithTeam();
      await prisma.openingHour.deleteMany({ where: { venueId: venue.id } });

      const res = await put(
        `/manage/venues/${venue.id}/opening-hours`,
        {
          days: [
            { weekday: 1, intervals: [{ from: '10:00', to: '23:00' }] },
            { weekday: 5, intervals: [{ from: '14:00', to: '02:00' }] },
          ],
        },
        manager.accessToken,
      );
      expect(res.statusCode).toBe(200);
      expect(res.json().openingHours).toEqual([
        { weekday: 1, intervals: [{ from: '10:00', to: '23:00', overnight: false }] },
        { weekday: 5, intervals: [{ from: '14:00', to: '02:00', overnight: true }] },
      ]);

      const publicView = (await get(t, `/venues/${venue.slug}`)).json();
      expect(publicView.openingHours.map((d: { weekday: number }) => d.weekday)).toEqual([1, 5]);
    });

    it('REMPLACE entièrement les horaires précédents', async () => {
      const { venue, manager } = await venueWithTeam();
      const url = `/manage/venues/${venue.id}/opening-hours`;
      await put(
        url,
        {
          days: [
            {
              weekday: 2,
              intervals: [
                { from: '09:00', to: '12:00' },
                { from: '14:00', to: '22:00' },
              ],
            },
          ],
        },
        manager.accessToken,
      );
      const res = await put(
        url,
        { days: [{ weekday: 3, intervals: [{ from: '08:00', to: '20:00' }] }] },
        manager.accessToken,
      );
      expect(res.json().openingHours).toHaveLength(1);
      expect(await prisma.openingHour.count({ where: { venueId: venue.id, fieldId: null } })).toBe(
        1,
      );
    });

    it('les créneaux publics suivent immédiatement les nouveaux horaires', async () => {
      const { venue, manager } = await venueWithTeam();
      const date = DATE;
      const weekday = ((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
      await put(
        `/manage/venues/${venue.id}/opening-hours`,
        { days: [{ weekday, intervals: [{ from: '20:00', to: '22:00' }] }] },
        manager.accessToken,
      );
      const res = await get(t, `/venues/${venue.slug}/availability?date=${date}`);
      expect(res.json().fields[0].slots.map((s: { startsAt: string }) => s.startsAt)).toEqual([
        slotAt(date, '20:00').toISOString(),
        slotAt(date, '21:00').toISOString(),
      ]);
    });

    it.each([
      [
        'jour en double',
        {
          days: [
            { weekday: 1, intervals: [{ from: '10:00', to: '12:00' }] },
            { weekday: 1, intervals: [{ from: '14:00', to: '16:00' }] },
          ],
        },
      ],
      [
        'plages qui se chevauchent',
        {
          days: [
            {
              weekday: 1,
              intervals: [
                { from: '10:00', to: '15:00' },
                { from: '14:00', to: '18:00' },
              ],
            },
          ],
        },
      ],
      ['début = fin', { days: [{ weekday: 1, intervals: [{ from: '10:00', to: '10:00' }] }] }],
      ['jour invalide', { days: [{ weekday: 8, intervals: [{ from: '10:00', to: '12:00' }] }] }],
      ['heure invalide', { days: [{ weekday: 1, intervals: [{ from: '25:00', to: '12:00' }] }] }],
      [
        'fermeture trop tardive (après 06:00)',
        { days: [{ weekday: 1, intervals: [{ from: '10:00', to: '07:00' }] }] },
      ],
    ])('refuse : %s — sans rien modifier', async (_label, payload) => {
      const { venue, manager } = await venueWithTeam();
      const before = await prisma.openingHour.count({ where: { venueId: venue.id } });
      expect(
        (await put(`/manage/venues/${venue.id}/opening-hours`, payload, manager.accessToken))
          .statusCode,
      ).toBe(400);
      expect(await prisma.openingHour.count({ where: { venueId: venue.id } })).toBe(before);
    });

    it('un terrain peut avoir ses propres horaires ; `days: []` revient aux horaires du complexe', async () => {
      const { venue, field, manager } = await venueWithTeam();
      const url = `/manage/venues/${venue.id}/fields/${field.id}/opening-hours`;

      const set = await put(
        url,
        {
          days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
            weekday,
            intervals: [{ from: '08:00', to: '10:00' }],
          })),
        },
        manager.accessToken,
      );
      expect(set.statusCode).toBe(200);
      expect(set.json().openingHours).toHaveLength(7);
      let day = (await get(t, `/venues/${venue.slug}/availability?date=${DATE}`)).json();
      expect(day.fields[0].slots).toHaveLength(2);

      const reset = await put(url, { days: [] }, manager.accessToken);
      expect(reset.json().openingHours).toEqual([]);
      day = (await get(t, `/venues/${venue.slug}/availability?date=${DATE}`)).json();
      expect(day.fields[0].slots).toHaveLength(13); // retour aux horaires du complexe
    });
  });

  // ───────────────────────── Tarifs ─────────────────────────

  describe('règles de prix', () => {
    const rule = (overrides: Record<string, unknown> = {}) => ({
      weekdays: [1, 2, 3, 4, 5, 6, 7],
      from: '10:00',
      to: '23:00',
      priceMinor: 4000,
      ...overrides,
    });

    it('crée, liste, modifie et supprime des règles ; chaque changement est audité avec l’ancien et le nouveau prix', async () => {
      const { venue, field, manager } = await venueWithTeam();
      await prisma.pricingRule.deleteMany({ where: { fieldId: field.id } });
      const base = `/manage/venues/${venue.id}/fields/${field.id}/pricing-rules`;

      const created = await post(t, base, rule(), bearer(manager.accessToken));
      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({
        weekdays: [1, 2, 3, 4, 5, 6, 7],
        from: '10:00',
        to: '23:00',
        overnight: false,
        priceMinor: 4000,
        priority: 0,
        isActive: true,
      });
      const ruleId = created.json().id;

      expect((await get(t, base, manager.accessToken)).json()).toHaveLength(1);

      const updated = await patch(
        t,
        `${base}/${ruleId}`,
        { priceMinor: 4500 },
        manager.accessToken,
      );
      expect(updated.statusCode).toBe(200);
      expect(updated.json()).toMatchObject({ priceMinor: 4500, from: '10:00', to: '23:00' }); // les autres champs sont conservés

      // Modifier un seul bord de la plage : l'autre est conservé
      const narrowed = await patch(t, `${base}/${ruleId}`, { from: '12:00' }, manager.accessToken);
      expect(narrowed.json()).toMatchObject({ from: '12:00', to: '23:00' });

      expect((await del(t, `${base}/${ruleId}`, manager.accessToken)).statusCode).toBe(204);
      expect((await get(t, base, manager.accessToken)).json()).toEqual([]);

      const audits = await prisma.auditLog.findMany({
        where: { entityId: ruleId },
        orderBy: { createdAt: 'asc' },
      });
      expect(audits.map((a) => a.action)).toEqual([
        'pricing.create',
        'pricing.update',
        'pricing.update',
        'pricing.delete',
      ]);
      expect(audits[1]?.before).toMatchObject({ priceMinor: 4000 });
      expect(audits[1]?.after).toMatchObject({ priceMinor: 4500 });
      expect(audits.every((a) => a.actorId === manager.userId)).toBe(true);
    });

    it('les tarifs apparaissent dans les disponibilités publiques : heures de pointe prioritaires', async () => {
      const { venue, field, owner } = await venueWithTeam();
      await prisma.pricingRule.deleteMany({ where: { fieldId: field.id } });
      const base = `/manage/venues/${venue.id}/fields/${field.id}/pricing-rules`;
      await post(t, base, rule({ priceMinor: 4000 }), bearer(owner.accessToken));
      await post(
        t,
        base,
        rule({ from: '18:00', to: '23:00', priceMinor: 6500, priority: 10 }),
        bearer(owner.accessToken),
      );

      const slots = (await get(t, `/venues/${venue.slug}/availability?date=${DATE}`)).json()
        .fields[0].slots as { startsAt: string; priceMinor: number }[];
      const priceAt = (hhmm: string) =>
        slots.find((s) => s.startsAt === slotAt(DATE, hhmm).toISOString())?.priceMinor;
      expect(priceAt('12:00')).toBe(4000);
      expect(priceAt('19:00')).toBe(6500);
      expect(priceAt('18:00')).toBe(6500);
      expect(priceAt('17:00')).toBe(4000);
    });

    it('prend en charge une plage après minuit (22:00 → 02:00)', async () => {
      const { venue, field, owner } = await venueWithTeam();
      const res = await post(
        t,
        `/manage/venues/${venue.id}/fields/${field.id}/pricing-rules`,
        rule({ from: '22:00', to: '02:00', priceMinor: 7000 }),
        bearer(owner.accessToken),
      );
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ from: '22:00', to: '02:00', overnight: true });
    });

    it.each([
      ['prix nul', { priceMinor: 0 }],
      ['prix négatif', { priceMinor: -500 }],
      ['prix décimal', { priceMinor: 4000.5 }],
      ['prix aberrant (faute de frappe)', { priceMinor: 400000 }],
      ['aucun jour', { weekdays: [] }],
      ['jour invalide', { weekdays: [0] }],
      ['plage début = fin', { from: '18:00', to: '18:00' }],
      ['validité inversée', { validFrom: '2026-12-01', validTo: '2026-11-01' }],
      ['champ interdit (fieldId)', { fieldId: '00000000-0000-4000-8000-000000000000' }],
    ])('refuse : %s', async (_label, override) => {
      const { venue, field, owner } = await venueWithTeam();
      const res = await post(
        t,
        `/manage/venues/${venue.id}/fields/${field.id}/pricing-rules`,
        rule(override),
        bearer(owner.accessToken),
      );
      expect(res.statusCode).toBe(400);
    });

    it('refuse une modification qui rendrait la plage invalide, ou la validité incohérente', async () => {
      const { venue, field, owner } = await venueWithTeam();
      const base = `/manage/venues/${venue.id}/fields/${field.id}/pricing-rules`;
      const id = (
        await post(t, base, rule({ from: '10:00', to: '12:00' }), bearer(owner.accessToken))
      ).json().id;
      expect((await patch(t, `${base}/${id}`, { to: '10:00' }, owner.accessToken)).statusCode).toBe(
        400,
      ); // début = fin
      await patch(t, `${base}/${id}`, { validFrom: '2026-11-01' }, owner.accessToken);
      expect(
        (await patch(t, `${base}/${id}`, { validTo: '2026-10-01' }, owner.accessToken)).statusCode,
      ).toBe(400);
    });

    it('une règle désactivée n’est plus appliquée ; 404 pour une règle inconnue', async () => {
      const { venue, field, owner } = await venueWithTeam();
      await prisma.pricingRule.deleteMany({ where: { fieldId: field.id } });
      const base = `/manage/venues/${venue.id}/fields/${field.id}/pricing-rules`;
      const id = (await post(t, base, rule(), bearer(owner.accessToken))).json().id;
      await patch(t, `${base}/${id}`, { isActive: false }, owner.accessToken);

      const slots = (await get(t, `/venues/${venue.slug}/availability?date=${DATE}`)).json()
        .fields[0].slots;
      expect(slots).toEqual([]); // plus aucun tarif actif : rien de vendable
      expect(
        (
          await patch(
            t,
            `${base}/00000000-0000-4000-8000-000000000000`,
            { priceMinor: 1 },
            owner.accessToken,
          )
        ).statusCode,
      ).toBe(404);
    });
  });

  // ───────────────────────── Calendrier complet ─────────────────────────

  describe('GET /manage/venues/:id/availability (vue complète)', () => {
    it('expose tous les statuts : réservé, bloqué, en cours de paiement, sans prix', async () => {
      const { venue, field, staff } = await venueWithTeam();
      const ids = { fieldId: field.id, venueId: venue.id };
      const noPrice = await prisma.field.create({
        data: { venueId: venue.id, name: 'Sans tarif' },
      });
      await book(ids, DATE, '10:00');
      await book(ids, DATE, '11:00', { type: 'BLOCK' });
      await book(ids, DATE, '12:00', {
        status: 'PENDING_PAYMENT',
        holdExpiresAt: new Date(Date.now() + 5 * 60_000),
      });

      const res = await get(
        t,
        `/manage/venues/${venue.id}/availability?date=${DATE}`,
        staff.accessToken,
      );
      expect(res.statusCode).toBe(200);
      const fields = res.json().fields as { fieldId: string; slots: { status: string }[] }[];
      const main = fields.find((f) => f.fieldId === field.id);
      expect(main?.slots.slice(0, 4).map((s) => s.status)).toEqual([
        'BOOKED',
        'BLOCKED',
        'HELD',
        'AVAILABLE',
      ]);
      const unpriced = fields.find((f) => f.fieldId === noPrice.id);
      expect(unpriced?.slots.every((s) => s.status === 'NO_PRICE')).toBe(true);
    });

    it('autorise la consultation d’une date passée (historique du calendrier)', async () => {
      const { venue, staff } = await venueWithTeam();
      const res = await get(
        t,
        `/manage/venues/${venue.id}/availability?date=${dayIn(-3)}`,
        staff.accessToken,
      );
      expect(res.statusCode).toBe(200);
      expect(res.json().fields[0].slots.every((s: { status: string }) => s.status === 'PAST')).toBe(
        true,
      );
    });
  });
});
