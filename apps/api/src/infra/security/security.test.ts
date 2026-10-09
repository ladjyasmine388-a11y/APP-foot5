import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { AppException } from '../../common/errors/app-exception.js';
import { loadEnv } from '../config/env.js';
import { generateOpaqueToken, hashToken, safeEqual } from './crypto.js';
import { PasswordService } from './password.service.js';
import { TokenService } from './token.service.js';

const env = loadEnv({
  NODE_ENV: 'test',
  WEB_ORIGIN: 'http://localhost:5173',
  DATABASE_URL: 'postgresql://u:p@localhost:5432/x_test',
  JWT_ACCESS_SECRET: 'unit-test-secret-with-more-than-32-characters',
  PAYMENT_WEBHOOK_SECRET: 'unit-test-webhook-secret-123456',
});

describe('crypto', () => {
  it('génère des jetons opaques de 256 bits, uniques, en base64url', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => generateOpaqueToken()));
    expect(tokens.size).toBe(200);
    for (const token of tokens) expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('hashToken est déterministe, irréversible en pratique, et différent du jeton', () => {
    const token = generateOpaqueToken();
    expect(hashToken(token)).toBe(hashToken(token));
    expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(token)).not.toBe(token);
    expect(hashToken(token)).not.toBe(hashToken(`${token}x`));
  });

  it('safeEqual compare sans fuite de longueur ni de contenu', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('PasswordService (Argon2id)', () => {
  const service = new PasswordService();

  it('produit une empreinte Argon2id salée : deux hachages du même mot de passe diffèrent', async () => {
    const [a, b] = await Promise.all([
      service.hash('un-bon-mot-de-passe'),
      service.hash('un-bon-mot-de-passe'),
    ]);
    expect(a).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(a).not.toBe(b);
  });

  it('vérifie le bon mot de passe et refuse les autres', async () => {
    const hash = await service.hash('un-bon-mot-de-passe');
    expect(await service.verify(hash, 'un-bon-mot-de-passe')).toBe(true);
    expect(await service.verify(hash, 'un-bon-mot-de-passe ')).toBe(false);
    expect(await service.verify(hash, 'UN-BON-MOT-DE-PASSE')).toBe(false);
  });

  it('une empreinte corrompue ne permet jamais de se connecter (et ne plante pas)', async () => {
    expect(await service.verify('pas-une-empreinte', 'x')).toBe(false);
    expect(await service.verify('', 'x')).toBe(false);
  });

  it('gère les mots de passe unicode (arabe, emoji)', async () => {
    const password = 'كلمة-مرور-قوية-٢٠٢٦-⚽';
    expect(await service.verify(await service.hash(password), password)).toBe(true);
  });

  it('verifyAgainstDummy ne lève jamais (égalisation du temps pour les emails inconnus)', async () => {
    await expect(service.verifyAgainstDummy('nimporte-quoi')).resolves.toBeUndefined();
  });
});

describe('TokenService (JWT)', () => {
  const tokens = new TokenService(env);
  const secret = new TextEncoder().encode(env.JWT_ACCESS_SECRET);

  it('signe puis vérifie un jeton : identité et session restituées', async () => {
    const jwt = await tokens.signAccessToken({ userId: 'user-1', sessionId: 'session-1' });
    expect(await tokens.verifyAccessToken(jwt)).toEqual({
      userId: 'user-1',
      sessionId: 'session-1',
    });
  });

  it('le jeton ne contient que l’identité et la session (ni rôle, ni email, ni donnée personnelle)', async () => {
    const jwt = await tokens.signAccessToken({ userId: 'user-1', sessionId: 'session-1' });
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString());
    expect(Object.keys(payload).sort()).toEqual(['aud', 'exp', 'iat', 'iss', 'sid', 'sub']);
  });

  it('expire après la durée configurée', async () => {
    const jwt = await tokens.signAccessToken({ userId: 'u', sessionId: 's' });
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString());
    expect(payload.exp - payload.iat).toBe(env.JWT_ACCESS_TTL_SECONDS);
  });

  it('refuse une signature falsifiée', async () => {
    const jwt = await tokens.signAccessToken({ userId: 'u', sessionId: 's' });
    const [header, payload, signature] = jwt.split('.');
    const tampered = `${header}.${payload}.${signature?.slice(0, -2)}AA`;
    await expect(tokens.verifyAccessToken(tampered)).rejects.toMatchObject({
      code: 'TOKEN_INVALID',
    });
  });

  it('refuse un jeton dont le contenu a été modifié (élévation d’identité)', async () => {
    const jwt = await tokens.signAccessToken({ userId: 'victime', sessionId: 's' });
    const [header, , signature] = jwt.split('.');
    const forgedPayload = Buffer.from(JSON.stringify({ sub: 'admin', sid: 's' })).toString(
      'base64url',
    );
    await expect(
      tokens.verifyAccessToken(`${header}.${forgedPayload}.${signature}`),
    ).rejects.toBeInstanceOf(AppException);
  });

  it('refuse un jeton sans identifiant de session', async () => {
    const jwt = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('u')
      .setIssuer('footfive-api')
      .setAudience('footfive-clients')
      .setExpirationTime('10m')
      .sign(secret);
    await expect(tokens.verifyAccessToken(jwt)).rejects.toMatchObject({ code: 'TOKEN_INVALID' });
  });

  it('refuse un autre algorithme (HS512) même avec le bon secret : liste blanche stricte', async () => {
    const jwt = await new SignJWT({ sid: 's' })
      .setProtectedHeader({ alg: 'HS512' })
      .setSubject('u')
      .setIssuer('footfive-api')
      .setAudience('footfive-clients')
      .setExpirationTime('10m')
      .sign(secret);
    await expect(tokens.verifyAccessToken(jwt)).rejects.toMatchObject({ code: 'TOKEN_INVALID' });
  });

  it('distingue un jeton expiré (TOKEN_EXPIRED) d’un jeton invalide', async () => {
    const expired = await new SignJWT({ sid: 's' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('u')
      .setIssuer('footfive-api')
      .setAudience('footfive-clients')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(secret);
    await expect(tokens.verifyAccessToken(expired)).rejects.toMatchObject({
      code: 'TOKEN_EXPIRED',
    });
    await expect(tokens.verifyAccessToken('n.importe.quoi')).rejects.toMatchObject({
      code: 'TOKEN_INVALID',
    });
  });
});
