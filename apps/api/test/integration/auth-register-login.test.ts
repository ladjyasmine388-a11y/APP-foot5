import { Controller, Get } from '@nestjs/common';
import { SignJWT } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RequireVerifiedEmail, Roles } from '../../src/modules/auth/auth.decorators.js';
import {
  type TestApp,
  WEB_ORIGIN,
  bearer,
  craftAccessToken,
  createTestApp,
  get,
  post,
  refreshCookieOf,
  signup,
  validRegistration,
} from './app-helper.js';
import { prisma, resetDb } from './helpers.js';

/** Routes jetables : vérifient les gardes de rôle et d'email vérifié, qui serviront à toute l'API. */
@Controller('test-guards')
class GuardsProbeController {
  @Get('admin-only')
  @Roles('ADMIN')
  adminOnly() {
    return { ok: true };
  }

  @Get('verified-only')
  @RequireVerifiedEmail()
  verifiedOnly() {
    return { ok: true };
  }
}

describe('inscription et connexion', () => {
  let t: TestApp;

  beforeAll(async () => {
    await resetDb();
    t = await createTestApp([GuardsProbeController]);
  });
  afterAll(() => t.close());
  beforeEach(() => {
    t.rateLimits.reset();
    t.mailer.reset();
  });

  describe('POST /auth/register', () => {
    it('crée le compte, normalise email et téléphone, ouvre une session web (cookie httpOnly)', async () => {
      const body = validRegistration({ email: 'Nouveau.Joueur@Example.COM' });
      const res = await post(t, '/auth/register', body);

      expect(res.statusCode).toBe(201);
      const json = res.json();
      expect(json.tokenType).toBe('Bearer');
      expect(json.expiresIn).toBe(900);
      expect(json.accessToken).toEqual(expect.any(String));
      expect(json.user).toMatchObject({
        email: 'nouveau.joueur@example.com',
        phone: '+213550123456',
        emailVerified: false,
        platformRole: 'USER',
        level: 'BEGINNER',
      });

      // Web : le refresh token est dans un cookie httpOnly, JAMAIS dans le corps.
      expect(json.refreshToken).toBeUndefined();
      const cookie = res.cookies.find((c) => c.name === 'ff_refresh');
      expect(cookie).toBeDefined();
      expect(cookie?.httpOnly).toBe(true);
      expect(cookie?.path).toBe('/api/v1/auth');
      expect(String(cookie?.sameSite).toLowerCase()).toBe('lax');
    });

    it('ne divulgue jamais l’empreinte du mot de passe, et la stocke en Argon2id', async () => {
      const body = validRegistration();
      const res = await post(t, '/auth/register', body);
      expect(res.body).not.toContain('passwordHash');
      expect(res.body).not.toContain('argon2');

      const row = await prisma.user.findUniqueOrThrow({ where: { email: body.email } });
      expect(row.passwordHash).toMatch(/^\$argon2id\$/);
      expect(row.passwordHash).not.toContain(body.password);
    });

    it('crée la fiche de fiabilité et envoie l’email de vérification (lien valable, jeton non stocké en clair)', async () => {
      const body = validRegistration({ locale: 'ar' });
      await post(t, '/auth/register', body);

      const user = await prisma.user.findUniqueOrThrow({
        where: { email: body.email },
        include: { stats: true },
      });
      expect(user.stats?.reliabilityScore).toBe(100);

      const mails = t.mailer.to(body.email);
      expect(mails).toHaveLength(1);
      expect(mails[0]?.text).toContain(`${WEB_ORIGIN}/verify-email?token=`);
      expect(mails[0]?.subject).toMatch(/[؀-ۿ]/); // email en arabe

      const token = t.mailer.lastToken(body.email);
      const stored = await prisma.emailToken.findFirstOrThrow({ where: { userId: user.id } });
      expect(stored.tokenHash).not.toBe(token);
      expect(stored.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('un client mobile reçoit le refresh token dans le corps, sans cookie', async () => {
      const res = await post(t, '/auth/register', validRegistration(), {
        'x-client-platform': 'mobile',
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().refreshToken).toEqual(expect.any(String));
      expect(refreshCookieOf(res)).toBeUndefined();
    });

    it('refuse un email déjà utilisé, quelle que soit la casse (409 EMAIL_TAKEN)', async () => {
      const body = validRegistration({ email: 'doublon@example.com' });
      expect((await post(t, '/auth/register', body)).statusCode).toBe(201);

      const again = await post(t, '/auth/register', { ...body, email: 'DOUBLON@Example.com' });
      expect(again.statusCode).toBe(409);
      expect(again.json().error.code).toBe('EMAIL_TAKEN');
    });

    it('5 inscriptions SIMULTANÉES avec le même email : une seule réussit', async () => {
      const email = 'course@example.com';
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          post(t, '/auth/register', validRegistration({ email }), {}, '10.0.0.1'),
        ),
      );
      const statuses = results.map((r) => r.statusCode).sort();
      expect(statuses).toEqual([201, 409, 409, 409, 409]);
      expect(await prisma.user.count({ where: { email } })).toBe(1);
    });

    it('REFUSE de s’octroyer un rôle admin en ajoutant un champ (assignation de masse)', async () => {
      const body = validRegistration({ platformRole: 'ADMIN' });
      const res = await post(t, '/auth/register', body);

      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
      expect(await prisma.user.count({ where: { email: body.email } })).toBe(0);
    });

    it.each([
      ['mot de passe trop faible', { password: 'court' }, 'password'],
      ['téléphone invalide', { phone: 'abc' }, 'phone'],
      ['email invalide', { email: 'pas-un-email' }, 'email'],
      ['conditions non acceptées', { acceptTerms: false }, 'acceptTerms'],
      ['prénom dangereux', { firstName: '<img src=x onerror=alert(1)>' }, 'firstName'],
    ])('rejette : %s, en désignant le champ fautif', async (_label, override, field) => {
      const res = await post(t, '/auth/register', validRegistration(override));
      expect(res.statusCode).toBe(400);
      const { error } = res.json();
      expect(error.code).toBe('VALIDATION_ERROR');
      expect(error.details.map((d: { path: string }) => d.path)).toContain(field);
    });

    it('répond proprement à un JSON malformé et à un corps trop volumineux', async () => {
      const malformed = await t.app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        headers: { 'content-type': 'application/json' },
        payload: '{"email": ',
      });
      expect(malformed.statusCode).toBe(400);
      expect(malformed.json().error.code).toBe('VALIDATION_ERROR');

      const huge = await post(
        t,
        '/auth/register',
        validRegistration({ city: 'x'.repeat(200_000) }),
      );
      expect(huge.statusCode).toBe(413);
      expect(huge.json().error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('POST /auth/login', () => {
    it('ouvre une session avec les bons identifiants (email insensible à la casse)', async () => {
      const user = await signup(t);
      const res = await post(t, '/auth/login', {
        email: user.email.toUpperCase(),
        password: user.password,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().user.id).toBe(user.userId);
      expect(refreshCookieOf(res)).toEqual(expect.any(String));
    });

    it('mauvais mot de passe et email inconnu donnent EXACTEMENT la même réponse (pas d’énumération)', async () => {
      const user = await signup(t);
      const wrongPassword = await post(t, '/auth/login', {
        email: user.email,
        password: 'mauvais-mot-de-passe',
      });
      const unknownEmail = await post(t, '/auth/login', {
        email: 'inconnu@example.com',
        password: 'mauvais-mot-de-passe',
      });

      expect(wrongPassword.statusCode).toBe(401);
      expect(unknownEmail.statusCode).toBe(401);
      const a = wrongPassword.json().error;
      const b = unknownEmail.json().error;
      expect(a.code).toBe('INVALID_CREDENTIALS');
      expect({ code: a.code, message: a.message }).toEqual({ code: b.code, message: b.message });
    });

    it('un compte suspendu est refusé (403) seulement s’il fournit le BON mot de passe', async () => {
      const user = await signup(t);
      await prisma.user.update({ where: { id: user.userId }, data: { status: 'BLOCKED' } });

      const right = await post(t, '/auth/login', { email: user.email, password: user.password });
      expect(right.statusCode).toBe(403);
      expect(right.json().error.code).toBe('ACCOUNT_BLOCKED');

      const wrong = await post(t, '/auth/login', {
        email: user.email,
        password: 'mauvais-mot-de-passe',
      });
      expect(wrong.statusCode).toBe(401);
      expect(wrong.json().error.code).toBe('INVALID_CREDENTIALS');
    });

    it('un compte supprimé ne peut plus se connecter', async () => {
      const user = await signup(t);
      await prisma.user.update({ where: { id: user.userId }, data: { status: 'DELETED' } });
      const res = await post(t, '/auth/login', { email: user.email, password: user.password });
      expect(res.statusCode).toBe(401);
    });

    it('limite les tentatives : la 6e en 15 min pour un même couple IP + email est refusée (429)', async () => {
      const user = await signup(t);
      const attempt = (password: string) =>
        post(t, '/auth/login', { email: user.email, password }, {}, '10.0.0.2');

      for (let i = 0; i < 5; i++) {
        expect((await attempt('mauvais-mot-de-passe')).statusCode).toBe(401);
      }
      // Même avec le BON mot de passe : le blocage protège contre l'essai de milliers de mots de passe.
      const blocked = await attempt(user.password);
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json().error.code).toBe('RATE_LIMITED');
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    });

    it('le blocage d’un email depuis une IP ne bloque ni un autre email ni une autre IP', async () => {
      const victim = await signup(t);
      for (let i = 0; i < 6; i++) {
        await post(
          t,
          '/auth/login',
          { email: victim.email, password: 'x-mauvais' },
          {},
          '10.0.0.3',
        );
      }
      // Une autre IP peut toujours se connecter à ce compte : un attaquant ne peut pas verrouiller sa victime.
      const fromElsewhere = await post(
        t,
        '/auth/login',
        { email: victim.email, password: victim.password },
        {},
        '10.0.0.4',
      );
      expect(fromElsewhere.statusCode).toBe(200);

      const other = await signup(t);
      const otherEmail = await post(
        t,
        '/auth/login',
        { email: other.email, password: other.password },
        {},
        '10.0.0.3',
      );
      expect(otherEmail.statusCode).toBe(200);
    });
  });

  describe('format des erreurs', () => {
    it('toute erreur contient code, message et requestId identique à l’en-tête x-request-id', async () => {
      const res = await post(
        t,
        '/auth/login',
        { email: 'a@b.co', password: 'x' },
        { 'x-request-id': 'trace-abcdef-123' },
      );
      const { error } = res.json();
      expect(error.requestId).toBe('trace-abcdef-123');
      expect(res.headers['x-request-id']).toBe('trace-abcdef-123');
      expect(error.code).toBeDefined();
      expect(error.message).toEqual(expect.any(String));
    });

    it('une route inconnue donne une erreur NOT_FOUND au même format', async () => {
      // Aucune route ne correspond : la requête n'atteint pas les gardes, c'est donc un 404 même sans jeton.
      const res = await get(t, '/nexiste-pas');
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toMatchObject({ code: 'NOT_FOUND', message: expect.any(String) });
      expect(res.json().error.requestId).toBeDefined();
    });
  });

  describe('jetons d’accès et gardes', () => {
    it('GET /me exige un jeton : sans jeton → 401 UNAUTHENTICATED', async () => {
      const res = await get(t, '/me');
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('UNAUTHENTICATED');
    });

    it('accepte un jeton valide', async () => {
      const user = await signup(t);
      const res = await get(t, '/me', user.accessToken);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ id: user.userId, email: user.email });
    });

    it.each([
      ['jeton aléatoire', 'pas.un.jwt'],
      ['jeton vide de sens', 'abc'],
    ])('refuse un %s (401 TOKEN_INVALID)', async (_label, token) => {
      const res = await get(t, '/me', token);
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('TOKEN_INVALID');
    });

    it('refuse un jeton signé avec un AUTRE secret', async () => {
      const user = await signup(t);
      const forged = await craftAccessToken({
        userId: user.userId,
        sessionId: 'x',
        secret: 'un-autre-secret-de-plus-de-trente-deux-caracteres!',
      });
      const res = await get(t, '/me', forged);
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('TOKEN_INVALID');
    });

    it('refuse un jeton « alg: none » (non signé)', async () => {
      const user = await signup(t);
      const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
      const unsigned = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({
        sub: user.userId,
        sid: 'x',
        iss: 'footfive-api',
        aud: 'footfive-clients',
        exp: Math.floor(Date.now() / 1000) + 600,
      })}.`;
      const res = await get(t, '/me', unsigned);
      expect(res.statusCode).toBe(401);
    });

    it('refuse un jeton d’un autre émetteur ou d’une autre audience', async () => {
      const user = await signup(t);
      const wrongIssuer = await craftAccessToken({
        userId: user.userId,
        sessionId: 'x',
        issuer: 'autre',
      });
      const wrongAudience = await craftAccessToken({
        userId: user.userId,
        sessionId: 'x',
        audience: 'autre',
      });
      expect((await get(t, '/me', wrongIssuer)).statusCode).toBe(401);
      expect((await get(t, '/me', wrongAudience)).statusCode).toBe(401);
    });

    it('refuse un jeton expiré avec un code dédié (TOKEN_EXPIRED) pour déclencher le refresh côté client', async () => {
      const user = await signup(t);
      const expired = await new SignJWT({ sid: 'x' })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(user.userId)
        .setIssuer('footfive-api')
        .setAudience('footfive-clients')
        .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
        .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
        .sign(new TextEncoder().encode(process.env['JWT_ACCESS_SECRET']));
      const res = await get(t, '/me', expired);
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('TOKEN_EXPIRED');
    });

    it('refuse un jeton correctement signé mais pointant une session inexistante', async () => {
      const user = await signup(t);
      const orphan = await craftAccessToken({
        userId: user.userId,
        sessionId: '00000000-0000-4000-8000-000000000000',
      });
      const res = await get(t, '/me', orphan);
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('TOKEN_INVALID');
    });

    it('bloquer un compte coupe son jeton d’accès IMMÉDIATEMENT (sans attendre l’expiration)', async () => {
      const user = await signup(t);
      expect((await get(t, '/me', user.accessToken)).statusCode).toBe(200);

      await prisma.user.update({ where: { id: user.userId }, data: { status: 'BLOCKED' } });
      const res = await get(t, '/me', user.accessToken);
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('ACCOUNT_BLOCKED');
    });

    it('une route publique ignore un jeton invalide au lieu d’échouer', async () => {
      const res = await get(t, '/health', 'jeton-perime');
      expect(res.statusCode).toBe(200);
    });

    it('route réservée aux admins : un joueur reçoit 403, un admin 200 (rôle relu en base)', async () => {
      const user = await signup(t);
      const denied = await get(t, '/test-guards/admin-only', user.accessToken);
      expect(denied.statusCode).toBe(403);
      expect(denied.json().error.code).toBe('FORBIDDEN');

      await prisma.user.update({ where: { id: user.userId }, data: { platformRole: 'ADMIN' } });
      expect((await get(t, '/test-guards/admin-only', user.accessToken)).statusCode).toBe(200);

      // Rétrogradation : prend effet tout de suite avec le MÊME jeton.
      await prisma.user.update({ where: { id: user.userId }, data: { platformRole: 'USER' } });
      expect((await get(t, '/test-guards/admin-only', user.accessToken)).statusCode).toBe(403);
    });

    it('route exigeant un email vérifié : refusée avant vérification (403 EMAIL_NOT_VERIFIED), acceptée après', async () => {
      const user = await signup(t);
      const before = await get(t, '/test-guards/verified-only', user.accessToken);
      expect(before.statusCode).toBe(403);
      expect(before.json().error.code).toBe('EMAIL_NOT_VERIFIED');

      await post(t, '/auth/verify-email', { token: t.mailer.lastToken(user.email) });
      expect((await get(t, '/test-guards/verified-only', user.accessToken)).statusCode).toBe(200);
    });

    it('toutes les routes sont privées par défaut : sans jeton, une route de test non marquée @Public est refusée', async () => {
      expect((await get(t, '/test-guards/admin-only')).statusCode).toBe(401);
      expect((await get(t, '/test-guards/verified-only')).statusCode).toBe(401);
      expect(bearer('x')).toEqual({ authorization: 'Bearer x' });
    });
  });

  describe('documentation OpenAPI', () => {
    it('expose la spécification avec les routes d’authentification', async () => {
      const res = await t.app.inject({ method: 'GET', url: '/api/docs-json' });
      expect(res.statusCode).toBe(200);
      const doc = res.json();
      expect(Object.keys(doc.paths)).toEqual(
        expect.arrayContaining([
          '/api/v1/auth/register',
          '/api/v1/auth/login',
          '/api/v1/auth/refresh',
          '/api/v1/me',
        ]),
      );
      // Les routes de santé (infrastructure) ne sont pas documentées côté public.
      expect(Object.keys(doc.paths)).not.toContain('/api/v1/health');
    });
  });
});
