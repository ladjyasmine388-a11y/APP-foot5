import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedBaseline } from '../../src/infra/database/baseline.js';
import { type Signup, type TestApp, createTestApp, del, get } from './app-helper.js';
import { jpegWithGps, pngWithText, webp } from './image-fixtures.js';
import { prisma, resetDb } from './helpers.js';
import { type World, createWorld, makeTeam, newPlayer } from './social-fixtures.js';

const STORAGE_DIR = resolve('.cache/test-storage');

describe('envoi d’images', () => {
  let t: TestApp;
  let w: World;
  let manager: Signup;

  beforeAll(async () => {
    await resetDb();
    await seedBaseline(prisma);
    t = await createTestApp();
    w = await createWorld(t);
    manager = await newPlayer(t);
    await prisma.venueStaff.create({ data: { venueId: w.venue.id, userId: manager.userId, role: 'MANAGER' } });
  });
  afterAll(() => t.close());
  beforeEach(() => t.rateLimits.reset());

  // ───────────────────────── Outils ─────────────────────────

  const send = (method: 'PUT' | 'POST', url: string, user: Signup | null, body: Buffer | string, contentType: string) =>
    t.app.inject({
      method,
      url: `/api/v1${url}`,
      payload: body,
      headers: { 'content-type': contentType, ...(user ? { authorization: `Bearer ${user.accessToken}` } : {}) },
    });
  const putAvatar = (user: Signup | null, body: Buffer | string, contentType = 'image/jpeg') => send('PUT', '/me/avatar', user, body, contentType);
  const path = (url: string): string => new URL(url).pathname.replace(/^\/api\/v1/, '');
  const files = async (): Promise<string[]> => readdir(STORAGE_DIR).catch(() => []);

  // ───────────────────────── Photo de profil ─────────────────────────

  describe('photo de profil', () => {
    it('enregistre l’image, la sert publiquement avec des en-têtes sûrs, et retire la position GPS', async () => {
      const user = await newPlayer(t);
      const res = await putAvatar(user, jpegWithGps());
      expect(res.statusCode).toBe(200);
      expect(res.json().url).toMatch(/\/api\/v1\/uploads\/[0-9a-f-]{36}\.jpg$/);
      expect((await get(t, '/me', user.accessToken)).json().avatarUrl).toBe(res.json().url);

      const served = await get(t, path(res.json().url)); // sans aucune connexion
      expect(served.statusCode).toBe(200);
      expect(served.headers['content-type']).toBe('image/jpeg');
      expect(served.headers['cache-control']).toBe('public, max-age=31536000, immutable');
      expect(served.headers['x-content-type-options']).toBe('nosniff');
      expect(served.headers['content-security-policy']).toContain("default-src 'none'");
      expect(served.headers['cross-origin-resource-policy']).toBe('cross-origin');
      expect(served.rawPayload.includes(Buffer.from('GPS'))).toBe(false); // EXIF retiré
      expect(served.rawPayload.includes(Buffer.from('JFIF'))).toBe(true);
      expect(served.rawPayload.includes(Buffer.from('pixels'))).toBe(true);
    });

    it('accepte PNG (texte retiré) et WebP', async () => {
      const user = await newPlayer(t);
      const png = await putAvatar(user, pngWithText(), 'image/png');
      expect(png.statusCode).toBe(200);
      const body = (await get(t, path(png.json().url))).rawPayload;
      expect(body.includes(Buffer.from('Paris-GPS'))).toBe(false);
      expect(body.includes(Buffer.from('IDAT'))).toBe(true);

      const web = await putAvatar(user, webp(), 'image/webp');
      expect(web.statusCode).toBe(200);
      expect((await get(t, path(web.json().url))).headers['content-type']).toBe('image/webp');
    });

    it('remplacer l’image supprime l’ancienne ; la supprimer vide le profil et le fichier', async () => {
      const user = await newPlayer(t);
      const first = (await putAvatar(user, jpegWithGps('un'))).json().url;
      const second = (await putAvatar(user, jpegWithGps('deux'))).json().url;
      expect(second).not.toBe(first);
      expect((await get(t, path(first))).statusCode).toBe(404);
      expect((await get(t, path(second))).statusCode).toBe(200);

      expect((await del(t, '/me/avatar', user.accessToken)).statusCode).toBe(204);
      expect((await get(t, '/me', user.accessToken)).json().avatarUrl).toBeNull();
      expect((await get(t, path(second))).statusCode).toBe(404);
      expect((await del(t, '/me/avatar', user.accessToken)).statusCode).toBe(204); // idempotent
    });

    it('ne supprime jamais un fichier qui n’est pas le nôtre (avatar externe historique)', async () => {
      const user = await newPlayer(t);
      await prisma.user.update({ where: { id: user.userId }, data: { avatarUrl: 'https://cdn.example.com/../../etc/passwd.jpg' } });
      expect((await putAvatar(user, jpegWithGps())).statusCode).toBe(200);
    });

    it('exige une connexion', async () => {
      expect((await putAvatar(null, jpegWithGps())).statusCode).toBe(401);
      expect((await del(t, '/me/avatar')).statusCode).toBe(401);
    });
  });

  // ───────────────────────── Fichiers refusés ─────────────────────────

  describe('validation', () => {
    it('refuse un fichier dont le contenu ne correspond pas au type annoncé', async () => {
      const user = await newPlayer(t);
      const before = (await files()).length;
      const cases: [string, Buffer | string, string][] = [
        ['PNG annoncé JPEG', pngWithText(), 'image/jpeg'],
        ['JPEG annoncé PNG', jpegWithGps(), 'image/png'],
        ['SVG annoncé PNG', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', 'image/png'],
        ['HTML annoncé JPEG', '<html><script>alert(1)</script></html>', 'image/jpeg'],
        ['exécutable annoncé WebP', Buffer.from('MZ\x90\0\x03\0\0\0'), 'image/webp'],
        ['JPEG tronqué', jpegWithGps().subarray(0, 14), 'image/jpeg'],
        ['PNG sans fin', pngWithText().subarray(0, 40), 'image/png'],
      ];
      for (const [label, body, type] of cases) {
        const res = await putAvatar(user, body, type);
        expect(res.statusCode, label).toBe(400);
        expect(res.json().error.code, label).toBe('VALIDATION_ERROR');
      }
      expect((await files()).length).toBe(before); // rien n'a été écrit
      expect((await get(t, '/me', user.accessToken)).json().avatarUrl).toBeNull();
    });

    it('refuse les types non supportés (SVG, GIF, JSON), un corps vide et une image trop lourde', async () => {
      const user = await newPlayer(t);
      expect((await putAvatar(user, '<svg/>', 'image/svg+xml')).statusCode).toBe(415);
      expect((await putAvatar(user, 'GIF89a', 'image/gif')).statusCode).toBe(415);
      expect((await putAvatar(user, '{"url":"https://evil.example/x.png"}', 'application/json')).statusCode).toBe(400);
      expect((await putAvatar(user, Buffer.alloc(0), 'image/jpeg')).statusCode).toBe(400);

      const huge = Buffer.concat([jpegWithGps().subarray(0, 4), Buffer.alloc(2 * 1024 * 1024 + 10)]);
      const tooBig = await putAvatar(user, huge, 'image/jpeg');
      expect(tooBig.statusCode).toBe(413);
    });

    it('le plafond de 2 Mo n’élargit pas celui des autres routes (JSON limité à 100 Ko)', async () => {
      const user = await newPlayer(t);
      const res = await t.app.inject({
        method: 'PATCH',
        url: '/api/v1/me',
        payload: JSON.stringify({ city: 'x'.repeat(150_000) }),
        headers: { 'content-type': 'application/json', authorization: `Bearer ${user.accessToken}` },
      });
      expect(res.statusCode).toBe(413);
    });
  });

  describe('lecture', () => {
    it('refuse les clés qui ne sont pas des noms générés (traversée de répertoire comprise) et ignore les fichiers inconnus', async () => {
      for (const key of ['..%2F..%2F.env', '../.env', 'x.jpg', 'passwd', '%2e%2e%2f%2e%2e%2fetc%2fpasswd', '00000000-0000-4000-8000-000000000000.svg', '00000000-0000-4000-8000-000000000000.jpg%00.png']) {
        const res = await get(t, `/uploads/${key}`);
        expect([400, 404], key).toContain(res.statusCode);
      }
      expect((await get(t, '/uploads/00000000-0000-4000-8000-000000000000.jpg')).statusCode).toBe(404);
    });
  });

  // ───────────────────────── Logo d'équipe ─────────────────────────

  describe('logo d’équipe', () => {
    it('le capitaine définit puis remplace le logo ; il apparaît sur la fiche', async () => {
      const captain = await newPlayer(t);
      const team = await makeTeam(t, captain, 3);
      const res = await send('PUT', `/teams/${team.id}/logo`, captain, pngWithText(), 'image/png');
      expect(res.statusCode).toBe(200);
      expect((await get(t, `/teams/${team.id}`, captain.accessToken)).json().logoUrl).toBe(res.json().url);
      expect(await prisma.auditLog.count({ where: { action: 'team.logo_set', entityId: team.id } })).toBe(1);

      const second = await send('PUT', `/teams/${team.id}/logo`, captain, pngWithText('autre'), 'image/png');
      expect((await get(t, path(res.json().url))).statusCode).toBe(404);
      expect((await get(t, path(second.json().url))).statusCode).toBe(200);
      expect((await del(t, `/teams/${team.id}/logo`, captain.accessToken)).statusCode).toBe(204);
      expect((await get(t, `/teams/${team.id}`, captain.accessToken)).json().logoUrl).toBeNull();
    });

    it('un simple membre, un étranger ou une équipe inconnue : refus AVANT d’écrire le moindre fichier', async () => {
      const captain = await newPlayer(t);
      const team = await makeTeam(t, captain, 3);
      const stranger = await newPlayer(t);
      const before = (await files()).length;

      expect((await send('PUT', `/teams/${team.id}/logo`, team.members[0]!, pngWithText(), 'image/png')).statusCode).toBe(403);
      expect((await send('PUT', `/teams/${team.id}/logo`, stranger, pngWithText(), 'image/png')).statusCode).toBe(403);
      expect((await send('PUT', '/teams/00000000-0000-4000-8000-000000000000/logo', captain, pngWithText(), 'image/png')).statusCode).toBe(404);
      expect((await send('PUT', `/teams/${team.id}/logo`, null, pngWithText(), 'image/png')).statusCode).toBe(401);
      expect((await files()).length).toBe(before);
      expect((await del(t, `/teams/${team.id}/logo`, stranger.accessToken)).statusCode).toBe(403);
    });
  });

  // ───────────────────────── Photos de complexe ─────────────────────────

  describe('photos de complexe', () => {
    const add = (user: Signup | null, venueId: string, body: Buffer = jpegWithGps(), type = 'image/jpeg') => send('POST', `/manage/venues/${venueId}/photos`, user, body, type);

    it('un gérant ajoute et retire des photos ; elles figurent sur la fiche publique', async () => {
      const world = await createWorld(t);
      const boss = await newPlayer(t);
      await prisma.venueStaff.create({ data: { venueId: world.venue.id, userId: boss.userId, role: 'MANAGER' } });

      const one = (await add(boss, world.venue.id, jpegWithGps('une'))).json().url;
      const two = (await add(boss, world.venue.id, jpegWithGps('deux'))).json().url;
      const detail = (await get(t, `/venues/${world.venue.slug}`)).json();
      expect(detail.photos).toEqual([one, two]);
      expect(await prisma.auditLog.count({ where: { action: 'venue.photo_add', entityId: world.venue.id } })).toBe(2);

      const key = one.split('/').pop() as string;
      expect((await del(t, `/manage/venues/${world.venue.id}/photos/${key}`, boss.accessToken)).statusCode).toBe(204);
      expect((await get(t, `/venues/${world.venue.slug}`)).json().photos).toEqual([two]);
      expect((await get(t, path(one))).statusCode).toBe(404); // le fichier est supprimé aussi
      expect((await del(t, `/manage/venues/${world.venue.id}/photos/${key}`, boss.accessToken)).statusCode).toBe(404);
      expect((await del(t, `/manage/venues/${world.venue.id}/photos/pas-une-cle`, boss.accessToken)).statusCode).toBe(400);
    });

    it('réservé aux gérants : le simple personnel (403) et un étranger (404) ne peuvent rien ajouter ni retirer', async () => {
      const before = (await files()).length;
      expect((await add(w.staff, w.venue.id)).statusCode).toBe(403);
      expect((await add(w.outsider, w.venue.id)).statusCode).toBe(404);
      expect((await add(null, w.venue.id)).statusCode).toBe(401);
      expect((await files()).length).toBe(before);

      const url = (await add(manager, w.venue.id)).json().url;
      const key = url.split('/').pop() as string;
      expect((await del(t, `/manage/venues/${w.venue.id}/photos/${key}`, w.staff.accessToken)).statusCode).toBe(403);
      expect((await del(t, `/manage/venues/${w.venue.id}/photos/${key}`, w.outsider.accessToken)).statusCode).toBe(404);
      expect((await get(t, path(url))).statusCode).toBe(200);
    });

    it('un gérant d’un AUTRE complexe ne peut pas toucher aux photos de celui-ci', async () => {
      const other = await createWorld(t);
      const otherBoss = await newPlayer(t);
      await prisma.venueStaff.create({ data: { venueId: other.venue.id, userId: otherBoss.userId, role: 'OWNER' } });
      const url = (await add(manager, w.venue.id)).json().url;
      const key = url.split('/').pop() as string;
      expect((await add(otherBoss, w.venue.id)).statusCode).toBe(404);
      expect((await del(t, `/manage/venues/${w.venue.id}/photos/${key}`, otherBoss.accessToken)).statusCode).toBe(404);
      expect((await del(t, `/manage/venues/${other.venue.id}/photos/${key}`, otherBoss.accessToken)).statusCode).toBe(404); // et ne peut pas la « réclamer »
      expect((await get(t, path(url))).statusCode).toBe(200);
    });

    it('10 photos au maximum ; la 11e est refusée sans laisser de fichier orphelin', async () => {
      const world = await createWorld(t);
      const boss = await newPlayer(t);
      await prisma.venueStaff.create({ data: { venueId: world.venue.id, userId: boss.userId, role: 'OWNER' } });
      for (let i = 0; i < 10; i++) expect((await add(boss, world.venue.id, jpegWithGps(`photo-${i}`))).statusCode).toBe(201);

      const before = (await files()).length;
      const eleventh = await add(boss, world.venue.id, jpegWithGps('onzième'));
      expect(eleventh.statusCode).toBe(409);
      expect((await files()).length).toBe(before);
      expect((await prisma.venue.findUniqueOrThrow({ where: { id: world.venue.id } })).photos).toHaveLength(10);
    });

    it('CONCURRENCE : 15 ajouts simultanés → jamais plus de 10 photos', async () => {
      const world = await createWorld(t);
      const boss = await newPlayer(t);
      await prisma.venueStaff.create({ data: { venueId: world.venue.id, userId: boss.userId, role: 'OWNER' } });
      const results = await Promise.all(Array.from({ length: 15 }, (_, i) => add(boss, world.venue.id, jpegWithGps(`course-${i}`))));
      expect(results.filter((r) => r.statusCode === 201)).toHaveLength(10);
      expect(results.filter((r) => r.statusCode === 409)).toHaveLength(5);
      expect((await prisma.venue.findUniqueOrThrow({ where: { id: world.venue.id } })).photos).toHaveLength(10);
    });
  });
});
