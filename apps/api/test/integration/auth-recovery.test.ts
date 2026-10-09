import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type TestApp, bearer, createTestApp, get, post, signup } from './app-helper.js';
import { prisma, resetDb } from './helpers.js';

describe('vérification d’email et mot de passe oublié', () => {
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

  describe('vérification d’email', () => {
    it('le lien reçu par email vérifie le compte', async () => {
      const user = await signup(t);
      expect((await get(t, '/me', user.accessToken)).json().emailVerified).toBe(false);

      const res = await post(t, '/auth/verify-email', { token: t.mailer.lastToken(user.email) });
      expect(res.statusCode).toBe(204);
      expect((await get(t, '/me', user.accessToken)).json().emailVerified).toBe(true);
    });

    it('le lien est à usage unique', async () => {
      const user = await signup(t);
      const token = t.mailer.lastToken(user.email);
      expect((await post(t, '/auth/verify-email', { token })).statusCode).toBe(204);

      const second = await post(t, '/auth/verify-email', { token });
      expect(second.statusCode).toBe(401);
      expect(second.json().error.code).toBe('TOKEN_INVALID');
    });

    it('le même lien utilisé 5 fois EN MÊME TEMPS ne réussit qu’une seule fois', async () => {
      const user = await signup(t);
      const token = t.mailer.lastToken(user.email);
      const results = await Promise.all(
        Array.from({ length: 5 }, () => post(t, '/auth/verify-email', { token })),
      );
      expect(results.filter((r) => r.statusCode === 204)).toHaveLength(1);
    });

    it('refuse un jeton inconnu, expiré, ou d’un autre type (réinitialisation)', async () => {
      const user = await signup(t);
      expect((await post(t, '/auth/verify-email', { token: 'x'.repeat(43) })).statusCode).toBe(401);

      const token = t.mailer.lastToken(user.email);
      await prisma.emailToken.updateMany({
        where: { userId: user.userId },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      expect((await post(t, '/auth/verify-email', { token })).statusCode).toBe(401);

      // Un jeton de réinitialisation ne peut pas servir à vérifier un email.
      await post(t, '/auth/forgot-password', { email: user.email });
      const resetToken = t.mailer.lastToken(user.email);
      expect((await post(t, '/auth/verify-email', { token: resetToken })).statusCode).toBe(401);
    });

    it('renvoyer l’email invalide l’ancien lien et en crée un nouveau', async () => {
      const user = await signup(t);
      const oldToken = t.mailer.lastToken(user.email);

      const res = await post(t, '/auth/resend-verification', undefined, bearer(user.accessToken));
      expect(res.statusCode).toBe(204);
      const newToken = t.mailer.lastToken(user.email);
      expect(newToken).not.toBe(oldToken);

      expect((await post(t, '/auth/verify-email', { token: oldToken })).statusCode).toBe(401);
      expect((await post(t, '/auth/verify-email', { token: newToken })).statusCode).toBe(204);
    });

    it('ne renvoie rien si l’email est déjà vérifié, et limite les renvois (3 par heure)', async () => {
      const verified = await signup(t);
      await post(t, '/auth/verify-email', { token: t.mailer.lastToken(verified.email) });
      t.mailer.reset();
      await post(t, '/auth/resend-verification', undefined, bearer(verified.accessToken));
      expect(t.mailer.sent).toHaveLength(0);

      const user = await signup(t);
      for (let i = 0; i < 3; i++) {
        const ok = await post(t, '/auth/resend-verification', undefined, bearer(user.accessToken));
        expect(ok.statusCode).toBe(204);
      }
      const limited = await post(
        t,
        '/auth/resend-verification',
        undefined,
        bearer(user.accessToken),
      );
      expect(limited.statusCode).toBe(429);
    });
  });

  describe('mot de passe oublié', () => {
    it('répond 202 de la MÊME façon que l’email existe ou non (pas d’énumération des comptes)', async () => {
      const user = await signup(t);
      t.mailer.reset();

      const known = await post(t, '/auth/forgot-password', { email: user.email });
      const unknown = await post(t, '/auth/forgot-password', { email: 'personne@example.com' });

      expect(known.statusCode).toBe(202);
      expect(unknown.statusCode).toBe(202);
      expect(known.json()).toEqual(unknown.json());
      // Mais seul le compte existant reçoit réellement un email.
      expect(t.mailer.to(user.email)).toHaveLength(1);
      expect(t.mailer.to('personne@example.com')).toHaveLength(0);
    });

    it('ne crée pas de lien pour un compte suspendu', async () => {
      const blocked = await signup(t);
      await prisma.user.update({ where: { id: blocked.userId }, data: { status: 'BLOCKED' } });
      t.mailer.reset();
      const res = await post(t, '/auth/forgot-password', { email: blocked.email });
      expect(res.statusCode).toBe(202);
      expect(t.mailer.sent).toHaveLength(0);
    });

    it('le lien permet de choisir un nouveau mot de passe : l’ancien cesse de fonctionner', async () => {
      const user = await signup(t);
      await post(t, '/auth/forgot-password', { email: user.email });
      const token = t.mailer.lastToken(user.email);

      const reset = await post(t, '/auth/reset-password', {
        token,
        password: 'nouveau-mot-de-passe-2026',
      });
      expect(reset.statusCode).toBe(204);

      const oldLogin = await post(t, '/auth/login', { email: user.email, password: user.password });
      expect(oldLogin.statusCode).toBe(401);
      const newLogin = await post(t, '/auth/login', {
        email: user.email,
        password: 'nouveau-mot-de-passe-2026',
      });
      expect(newLogin.statusCode).toBe(200);
    });

    it('la réinitialisation DÉCONNECTE tous les appareils, journalise l’action et prévient par email', async () => {
      const user = await signup(t);
      await post(t, '/auth/forgot-password', { email: user.email });
      const token = t.mailer.lastToken(user.email);
      t.mailer.reset();

      await post(t, '/auth/reset-password', { token, password: 'nouveau-mot-de-passe-2026' });

      // Un voleur qui avait une session ouverte la perd.
      expect((await get(t, '/me', user.accessToken)).statusCode).toBe(401);
      const refresh = await post(t, '/auth/refresh', { refreshToken: user.refreshToken });
      expect(refresh.statusCode).toBe(401);

      const audits = await prisma.auditLog.count({
        where: { action: 'auth.password_reset', actorId: user.userId },
      });
      expect(audits).toBe(1);
      expect(t.mailer.to(user.email)).toHaveLength(1); // « votre mot de passe a été modifié »
    });

    it('le lien est à usage unique, même utilisé 5 fois simultanément', async () => {
      const user = await signup(t);
      await post(t, '/auth/forgot-password', { email: user.email });
      const token = t.mailer.lastToken(user.email);

      const results = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          post(t, '/auth/reset-password', { token, password: `mot-de-passe-numero-${i}-ok` }),
        ),
      );
      expect(results.filter((r) => r.statusCode === 204)).toHaveLength(1);
    });

    it('un nouveau lien invalide le précédent (un seul lien valide à la fois)', async () => {
      const user = await signup(t);
      await post(t, '/auth/forgot-password', { email: user.email });
      const first = t.mailer.lastToken(user.email);
      await post(t, '/auth/forgot-password', { email: user.email });
      const second = t.mailer.lastToken(user.email);

      const withFirst = await post(t, '/auth/reset-password', {
        token: first,
        password: 'nouveau-mot-de-passe-2026',
      });
      expect(withFirst.statusCode).toBe(401);
      const withSecond = await post(t, '/auth/reset-password', {
        token: second,
        password: 'nouveau-mot-de-passe-2026',
      });
      expect(withSecond.statusCode).toBe(204);
    });

    it('refuse un lien expiré et applique la politique de mot de passe', async () => {
      const user = await signup(t);
      await post(t, '/auth/forgot-password', { email: user.email });
      const token = t.mailer.lastToken(user.email);

      const weak = await post(t, '/auth/reset-password', { token, password: 'court' });
      expect(weak.statusCode).toBe(400);

      await prisma.emailToken.updateMany({
        where: { userId: user.userId, type: 'RESET_PASSWORD' },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      const expired = await post(t, '/auth/reset-password', {
        token,
        password: 'nouveau-mot-de-passe-2026',
      });
      expect(expired.statusCode).toBe(401);
      expect(expired.json().error.code).toBe('TOKEN_INVALID');
    });

    it('limite les demandes : 3 par heure pour un même email depuis une IP', async () => {
      const user = await signup(t);
      for (let i = 0; i < 3; i++) {
        expect((await post(t, '/auth/forgot-password', { email: user.email })).statusCode).toBe(
          202,
        );
      }
      const limited = await post(t, '/auth/forgot-password', { email: user.email });
      expect(limited.statusCode).toBe(429);
      expect(limited.json().error.code).toBe('RATE_LIMITED');
    });

    it('un échec d’envoi d’email ne fait pas échouer la demande', async () => {
      const user = await signup(t);
      const original = t.mailer.send.bind(t.mailer);
      t.mailer.send = () => Promise.reject(new Error('SMTP indisponible'));
      try {
        const res = await post(t, '/auth/forgot-password', { email: user.email });
        expect(res.statusCode).toBe(202);
      } finally {
        t.mailer.send = original;
      }
    });
  });
});
