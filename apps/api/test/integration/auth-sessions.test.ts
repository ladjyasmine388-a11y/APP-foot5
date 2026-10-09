import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type TestApp,
  WEB_ORIGIN,
  createTestApp,
  get,
  post,
  refreshCookieOf,
  signup,
  validRegistration,
} from './app-helper.js';
import { prisma, resetDb } from './helpers.js';

/** Fait « vieillir » une rotation : simule un jeton réutilisé longtemps après avoir été remplacé. */
async function ageRotation(refreshToken: string): Promise<void> {
  const { hashToken } = await import('../../src/infra/security/crypto.js');
  await prisma.session.updateMany({
    where: { refreshTokenHash: hashToken(refreshToken) },
    data: { revokedAt: new Date(Date.now() - 60_000) },
  });
}

describe('sessions : refresh, rotation et révocation', () => {
  let t: TestApp;

  beforeAll(async () => {
    await resetDb();
    t = await createTestApp();
  });
  afterAll(() => t.close());
  beforeEach(() => t.rateLimits.reset());

  describe('rotation du refresh token (client mobile : jeton dans le corps)', () => {
    it('échange le refresh token contre de nouveaux jetons ; le nouvel accès fonctionne', async () => {
      const user = await signup(t);
      const res = await post(t, '/auth/refresh', { refreshToken: user.refreshToken });

      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.accessToken).toEqual(expect.any(String));
      expect(json.refreshToken).toEqual(expect.any(String));
      expect(json.refreshToken).not.toBe(user.refreshToken); // rotation : jeton remplacé
      expect((await get(t, '/me', json.accessToken)).statusCode).toBe(200);
    });

    it('le refresh token n’est jamais stocké en clair (seule son empreinte SHA-256 l’est)', async () => {
      const user = await signup(t);
      const rows = await prisma.session.findMany({ where: { userId: user.userId } });
      expect(rows.map((r) => r.refreshTokenHash)).not.toContain(user.refreshToken);
      expect(rows[0]?.refreshTokenHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('l’ancien access token reste valable après un refresh (la session survit à la rotation)', async () => {
      const user = await signup(t);
      await post(t, '/auth/refresh', { refreshToken: user.refreshToken });
      // Des requêtes déjà en vol avec l'ancien jeton ne doivent pas échouer pendant le renouvellement.
      expect((await get(t, '/me', user.accessToken)).statusCode).toBe(200);
    });

    it('réutiliser un refresh token PÉRIMÉ révoque toute la session (vol détecté) et est audité', async () => {
      const user = await signup(t);
      const rotated = (await post(t, '/auth/refresh', { refreshToken: user.refreshToken })).json();
      await ageRotation(user.refreshToken);

      // L'ancien jeton revient bien après sa rotation : quelqu'un d'autre le détient.
      const replay = await post(t, '/auth/refresh', { refreshToken: user.refreshToken });
      expect(replay.statusCode).toBe(401);
      expect(replay.json().error.code).toBe('REFRESH_REUSED');

      // Conséquence : le jeton LÉGITIME le plus récent est lui aussi révoqué, et les accès cessent.
      expect(
        (await post(t, '/auth/refresh', { refreshToken: rotated.refreshToken })).statusCode,
      ).toBe(401);
      expect((await get(t, '/me', rotated.accessToken)).statusCode).toBe(401);

      const audit = await prisma.auditLog.findFirst({
        where: { action: 'auth.refresh_reuse_detected', actorId: user.userId },
      });
      expect(audit).not.toBeNull();
    });

    it('deux rafraîchissements SIMULTANÉS : un seul réussit, l’autre reçoit un conflit sans révoquer la session', async () => {
      const user = await signup(t);
      const [a, b] = await Promise.all([
        post(t, '/auth/refresh', { refreshToken: user.refreshToken }),
        post(t, '/auth/refresh', { refreshToken: user.refreshToken }),
      ]);

      const statuses = [a.statusCode, b.statusCode].sort();
      expect(statuses).toEqual([200, 401]);
      const loser = a.statusCode === 401 ? a : b;
      const winner = a.statusCode === 200 ? a : b;
      expect(loser.json().error.code).toBe('REFRESH_CONFLICT');

      // Le conflit n'est PAS un vol : la session du gagnant reste utilisable.
      expect((await get(t, '/me', winner.json().accessToken)).statusCode).toBe(200);
      expect(
        (await post(t, '/auth/refresh', { refreshToken: winner.json().refreshToken })).statusCode,
      ).toBe(200);
    });

    it('refuse un refresh token inconnu ou absent', async () => {
      const unknown = await post(t, '/auth/refresh', { refreshToken: 'a'.repeat(43) });
      expect(unknown.statusCode).toBe(401);
      expect(unknown.json().error.code).toBe('TOKEN_INVALID');

      const absent = await post(t, '/auth/refresh', {});
      expect(absent.statusCode).toBe(401);
    });

    it('refuse un refresh token expiré (TOKEN_EXPIRED)', async () => {
      const user = await signup(t);
      await prisma.session.updateMany({
        where: { userId: user.userId },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      const res = await post(t, '/auth/refresh', { refreshToken: user.refreshToken });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('TOKEN_EXPIRED');
    });

    it('refuse de renouveler la session d’un compte suspendu', async () => {
      const user = await signup(t);
      await prisma.user.update({ where: { id: user.userId }, data: { status: 'BLOCKED' } });
      const res = await post(t, '/auth/refresh', { refreshToken: user.refreshToken });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('ACCOUNT_BLOCKED');
    });
  });

  describe('flux web : refresh token dans un cookie httpOnly + protection CSRF', () => {
    async function webLogin() {
      const body = validRegistration();
      const res = await post(t, '/auth/register', body);
      return { body, res, cookie: refreshCookieOf(res) as string };
    }

    it('renouvelle la session depuis le cookie quand l’origine est celle du web, et fait tourner le cookie', async () => {
      const { cookie } = await webLogin();
      const res = await post(
        t,
        '/auth/refresh',
        {},
        { cookie: `ff_refresh=${cookie}`, origin: WEB_ORIGIN },
      );

      expect(res.statusCode).toBe(200);
      expect(res.json().refreshToken).toBeUndefined(); // jamais dans le corps pour le web
      const newCookie = refreshCookieOf(res);
      expect(newCookie).toEqual(expect.any(String));
      expect(newCookie).not.toBe(cookie);
    });

    it.each([
      ['origine d’un site tiers', { origin: 'https://evil.example' }],
      ['en-tête Origin absent', {}],
      ['origine voisine du web', { origin: `${WEB_ORIGIN}.evil.example` }],
    ])('REFUSE le cookie avec %s (anti-CSRF)', async (_label, headers) => {
      const { cookie } = await webLogin();
      const res = await post(
        t,
        '/auth/refresh',
        {},
        { cookie: `ff_refresh=${cookie}`, ...headers },
      );
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('ORIGIN_NOT_ALLOWED');

      // Le refus ne consomme pas le jeton : l'utilisateur légitime peut toujours se renouveler.
      const legit = await post(
        t,
        '/auth/refresh',
        {},
        { cookie: `ff_refresh=${cookie}`, origin: WEB_ORIGIN },
      );
      expect(legit.statusCode).toBe(200);
    });

    it('le logout web efface le cookie et révoque la session', async () => {
      const { cookie, res } = await webLogin();
      const out = await post(
        t,
        '/auth/logout',
        {},
        { cookie: `ff_refresh=${cookie}`, origin: WEB_ORIGIN },
      );
      expect(out.statusCode).toBe(204);
      expect(out.headers['set-cookie']).toContain('ff_refresh=;');

      expect((await get(t, '/me', res.json().accessToken)).statusCode).toBe(401);
      const again = await post(
        t,
        '/auth/refresh',
        {},
        { cookie: `ff_refresh=${cookie}`, origin: WEB_ORIGIN },
      );
      expect(again.statusCode).toBe(401);
    });

    it('le logout par cookie exige aussi la bonne origine (un site tiers ne peut pas déconnecter l’utilisateur)', async () => {
      const { cookie, res } = await webLogin();
      const attack = await post(
        t,
        '/auth/logout',
        {},
        { cookie: `ff_refresh=${cookie}`, origin: 'https://evil.example' },
      );
      expect(attack.statusCode).toBe(403);
      expect((await get(t, '/me', res.json().accessToken)).statusCode).toBe(200);
    });
  });

  describe('déconnexion', () => {
    it('logout (mobile) révoque la session : access token et refresh token cessent de fonctionner', async () => {
      const user = await signup(t);
      const out = await post(t, '/auth/logout', { refreshToken: user.refreshToken });
      expect(out.statusCode).toBe(204);

      expect((await get(t, '/me', user.accessToken)).statusCode).toBe(401);
      expect((await post(t, '/auth/refresh', { refreshToken: user.refreshToken })).statusCode).toBe(
        401,
      );
    });

    it('logout est idempotent : un jeton inconnu n’est pas une erreur', async () => {
      expect((await post(t, '/auth/logout', { refreshToken: 'z'.repeat(43) })).statusCode).toBe(
        204,
      );
      expect((await post(t, '/auth/logout', {})).statusCode).toBe(204);
    });

    it('logout-all déconnecte TOUS les appareils de l’utilisateur, et seulement les siens', async () => {
      const alice = await signup(t);
      const bob = await signup(t);
      const aliceLaptop = (
        await post(
          t,
          '/auth/login',
          { email: alice.email, password: alice.password },
          { 'x-client-platform': 'mobile' },
        )
      ).json();

      const res = await post(t, '/auth/logout-all', undefined, {
        authorization: `Bearer ${alice.accessToken}`,
      });
      expect(res.statusCode).toBe(204);

      expect((await get(t, '/me', alice.accessToken)).statusCode).toBe(401);
      expect((await get(t, '/me', aliceLaptop.accessToken)).statusCode).toBe(401);
      expect((await get(t, '/me', bob.accessToken)).statusCode).toBe(200);
    });

    it('logout-all exige d’être connecté', async () => {
      expect((await post(t, '/auth/logout-all')).statusCode).toBe(401);
    });
  });
});
