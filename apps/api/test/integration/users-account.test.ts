import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type TestApp,
  bearer,
  createTestApp,
  del,
  get,
  patch,
  post,
  signup,
} from './app-helper.js';
import { bookingData, makeVenueWithField, prisma, resetDb } from './helpers.js';

describe('mon compte', () => {
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

  describe('PATCH /me', () => {
    it('modifie les champs autorisés et normalise le téléphone', async () => {
      const user = await signup(t);
      const res = await patch(
        t,
        '/me',
        {
          city: 'Oran',
          level: 'ADVANCED',
          phone: '0661 00 00 00',
          locale: 'ar',
          birthDate: '1995-06-15',
        },
        user.accessToken,
      );
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        city: 'Oran',
        level: 'ADVANCED',
        phone: '+213661000000',
        locale: 'ar',
        birthDate: '1995-06-15',
      });
    });

    it.each([
      ['platformRole', 'ADMIN'],
      ['email', 'pirate@example.com'],
      ['status', 'ACTIVE'],
      ['emailVerifiedAt', '2026-01-01T00:00:00.000Z'],
      ['passwordHash', 'x'],
      ['id', '00000000-0000-4000-8000-000000000000'],
    ])(
      'REFUSE de modifier « %s » (aucune élévation de privilège possible)',
      async (field, value) => {
        const user = await signup(t);
        const res = await patch(t, '/me', { city: 'Oran', [field]: value }, user.accessToken);
        expect(res.statusCode).toBe(400);

        const row = await prisma.user.findUniqueOrThrow({ where: { id: user.userId } });
        expect(row.platformRole).toBe('USER');
        expect(row.email).toBe(user.email);
        expect(row.city).toBeNull(); // rien n'a été appliqué, même pas le champ valide
      },
    );

    it('refuse une requête vide et exige d’être connecté', async () => {
      const user = await signup(t);
      expect((await patch(t, '/me', {}, user.accessToken)).statusCode).toBe(400);
      expect((await patch(t, '/me', { city: 'Oran' })).statusCode).toBe(401);
    });

    it('ne permet de modifier QUE son propre profil (l’identité vient du jeton, pas de la requête)', async () => {
      const alice = await signup(t);
      const bob = await signup(t);
      await patch(t, '/me', { city: 'Constantine' }, alice.accessToken);

      const bobRow = await prisma.user.findUniqueOrThrow({ where: { id: bob.userId } });
      expect(bobRow.city).toBeNull();
    });
  });

  describe('POST /me/change-password', () => {
    it('change le mot de passe, garde l’appareil courant et déconnecte les autres, puis prévient par email', async () => {
      const user = await signup(t);
      const other = (
        await post(
          t,
          '/auth/login',
          { email: user.email, password: user.password },
          { 'x-client-platform': 'mobile' },
        )
      ).json();
      t.mailer.reset();

      const res = await post(
        t,
        '/me/change-password',
        { currentPassword: user.password, newPassword: 'un-autre-mot-de-passe-2026' },
        bearer(user.accessToken),
      );
      expect(res.statusCode).toBe(204);

      expect((await get(t, '/me', user.accessToken)).statusCode).toBe(200); // appareil courant conservé
      expect((await get(t, '/me', other.accessToken)).statusCode).toBe(401); // autre appareil déconnecté
      expect(t.mailer.to(user.email)).toHaveLength(1);

      const login = await post(t, '/auth/login', {
        email: user.email,
        password: 'un-autre-mot-de-passe-2026',
      });
      expect(login.statusCode).toBe(200);
    });

    it('refuse si le mot de passe actuel est faux (un jeton volé ne suffit pas)', async () => {
      const user = await signup(t);
      const res = await post(
        t,
        '/me/change-password',
        { currentPassword: 'mauvais-mot-de-passe', newPassword: 'un-autre-mot-de-passe-2026' },
        bearer(user.accessToken),
      );
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('INVALID_CURRENT_PASSWORD');
    });

    it('applique la politique de mot de passe et refuse de réutiliser l’ancien', async () => {
      const user = await signup(t);
      const weak = await post(
        t,
        '/me/change-password',
        { currentPassword: user.password, newPassword: 'court' },
        bearer(user.accessToken),
      );
      expect(weak.statusCode).toBe(400);
      const same = await post(
        t,
        '/me/change-password',
        { currentPassword: user.password, newPassword: user.password },
        bearer(user.accessToken),
      );
      expect(same.statusCode).toBe(400);
    });
  });

  describe('appareils connectés', () => {
    it('liste mes sessions en désignant l’appareil courant', async () => {
      const user = await signup(t);
      await post(
        t,
        '/auth/login',
        { email: user.email, password: user.password },
        { 'x-client-platform': 'mobile' },
      );

      const res = await get(t, '/me/sessions', user.accessToken);
      expect(res.statusCode).toBe(200);
      const sessions = res.json();
      expect(sessions).toHaveLength(2);
      expect(sessions.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
      // Aucun refresh token ni empreinte ne fuite.
      expect(res.body).not.toMatch(/refreshToken|Hash/);
    });

    it('permet de déconnecter un de MES appareils', async () => {
      const user = await signup(t);
      const other = (
        await post(
          t,
          '/auth/login',
          { email: user.email, password: user.password },
          { 'x-client-platform': 'mobile' },
        )
      ).json();
      const sessions = (await get(t, '/me/sessions', user.accessToken)).json() as {
        id: string;
        current: boolean;
      }[];
      const target = sessions.find((s) => !s.current);

      expect((await del(t, `/me/sessions/${target?.id}`, user.accessToken)).statusCode).toBe(204);
      expect((await get(t, '/me', other.accessToken)).statusCode).toBe(401);
      expect((await get(t, '/me', user.accessToken)).statusCode).toBe(200);
    });

    it('ne permet PAS de déconnecter l’appareil de quelqu’un d’autre (pas d’IDOR)', async () => {
      const alice = await signup(t);
      const bob = await signup(t);
      const bobSession = (
        (await get(t, '/me/sessions', bob.accessToken)).json() as { id: string }[]
      )[0];

      const res = await del(t, `/me/sessions/${bobSession?.id}`, alice.accessToken);
      expect(res.statusCode).toBe(404);
      expect((await get(t, '/me', bob.accessToken)).statusCode).toBe(200); // la session de Bob est intacte
    });

    it('refuse un identifiant de session mal formé', async () => {
      const user = await signup(t);
      expect((await del(t, '/me/sessions/pas-un-uuid', user.accessToken)).statusCode).toBe(400);
    });
  });

  describe('POST /me/delete-account (anonymisation)', () => {
    it('refuse sans le bon mot de passe', async () => {
      const user = await signup(t);
      const res = await post(
        t,
        '/me/delete-account',
        { password: 'mauvais-mot-de-passe' },
        bearer(user.accessToken),
      );
      expect(res.statusCode).toBe(403);
      expect((await get(t, '/me', user.accessToken)).statusCode).toBe(200);
    });

    it('anonymise le compte : données personnelles effacées, connexion impossible, email libéré, audit conservé', async () => {
      const user = await signup(t);
      const res = await post(
        t,
        '/me/delete-account',
        { password: user.password },
        bearer(user.accessToken),
      );
      expect(res.statusCode).toBe(204);

      const row = await prisma.user.findUniqueOrThrow({ where: { id: user.userId } });
      expect(row).toMatchObject({
        status: 'DELETED',
        firstName: 'Utilisateur',
        lastName: 'supprimé',
        phone: '',
        passwordHash: null,
        city: null,
      });
      expect(row.email).toBe(`deleted-${user.userId}@deleted.invalid`);
      expect(row.anonymizedAt).not.toBeNull();
      expect(await prisma.session.count({ where: { userId: user.userId } })).toBe(0);

      expect((await get(t, '/me', user.accessToken)).statusCode).toBe(401);
      expect(
        (await post(t, '/auth/login', { email: user.email, password: user.password })).statusCode,
      ).toBe(401);
      expect(
        await prisma.auditLog.count({ where: { action: 'user.delete', actorId: user.userId } }),
      ).toBe(1);

      // L'email d'origine est libre : la personne peut se réinscrire.
      const again = await post(t, '/auth/register', {
        firstName: 'Yasmine',
        lastName: 'Benali',
        email: user.email,
        phone: '0550123456',
        password: 'un-bon-mot-de-passe',
        acceptTerms: true,
      });
      expect(again.statusCode).toBe(201);
    });

    it('refuse s’il reste une réservation à venir (409) et ne touche à rien', async () => {
      const user = await signup(t);
      const { venue, field } = await makeVenueWithField();
      await prisma.booking.create({
        data: bookingData(
          { fieldId: field.id, venueId: venue.id },
          { userId: user.userId, start: new Date(Date.now() + 48 * 3600 * 1000) },
        ),
      });

      const res = await post(
        t,
        '/me/delete-account',
        { password: user.password },
        bearer(user.accessToken),
      );
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('ACCOUNT_HAS_UPCOMING_BOOKINGS');
      expect((await prisma.user.findUniqueOrThrow({ where: { id: user.userId } })).status).toBe(
        'ACTIVE',
      );
    });

    it('accepte s’il ne reste que des réservations PASSÉES, qui sont conservées pour la comptabilité', async () => {
      const user = await signup(t);
      const { venue, field } = await makeVenueWithField();
      const past = await prisma.booking.create({
        data: {
          ...bookingData(
            { fieldId: field.id, venueId: venue.id },
            {
              userId: user.userId,
              start: new Date(Date.now() - 48 * 3600 * 1000),
              status: 'COMPLETED',
            },
          ),
        },
      });

      const res = await post(
        t,
        '/me/delete-account',
        { password: user.password },
        bearer(user.accessToken),
      );
      expect(res.statusCode).toBe(204);
      expect(await prisma.booking.findUnique({ where: { id: past.id } })).not.toBeNull();
    });

    it('refuse à un capitaine dont l’équipe a d’autres membres (transfert de capitainerie requis)', async () => {
      const captain = await signup(t);
      const member = await signup(t);
      const team = await prisma.team.create({
        data: { name: 'Les Lions', captainId: captain.userId },
      });
      await prisma.teamMember.createMany({
        data: [
          { teamId: team.id, userId: captain.userId, role: 'CAPTAIN' },
          { teamId: team.id, userId: member.userId },
        ],
      });

      const res = await post(
        t,
        '/me/delete-account',
        { password: captain.password },
        bearer(captain.accessToken),
      );
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('ACCOUNT_IS_TEAM_CAPTAIN');
    });

    it('archive l’équipe d’un capitaine qui en est le seul membre', async () => {
      const captain = await signup(t);
      const team = await prisma.team.create({
        data: { name: 'Solo FC', captainId: captain.userId },
      });
      await prisma.teamMember.create({
        data: { teamId: team.id, userId: captain.userId, role: 'CAPTAIN' },
      });

      const res = await post(
        t,
        '/me/delete-account',
        { password: captain.password },
        bearer(captain.accessToken),
      );
      expect(res.statusCode).toBe(204);
      expect(
        (await prisma.team.findUniqueOrThrow({ where: { id: team.id } })).deletedAt,
      ).not.toBeNull();
    });
  });
});
