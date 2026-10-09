import { Test } from '@nestjs/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp, createAdapter } from '../src/app.setup.js';
import { loadEnv } from '../src/infra/config/env.js';

describe('GET /api/v1/health', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(createAdapter());
    await configureApp(app, loadEnv());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  const get = (headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url: '/api/v1/health', headers });

  it('répond 200 avec le statut ok', async () => {
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok' });
  });

  it('applique les en-têtes de sécurité (helmet)', async () => {
    const res = await get();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('génère un identifiant de requête et le renvoie', async () => {
    const res = await get();
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('réutilise un identifiant client inoffensif mais rejette un identifiant suspect', async () => {
    const ok = await get({ 'x-request-id': 'client-req-12345' });
    expect(ok.headers['x-request-id']).toBe('client-req-12345');

    const bad = await get({ 'x-request-id': 'x'.repeat(200) });
    expect(bad.headers['x-request-id']).not.toBe('x'.repeat(200));
  });

  it('refuse les origines CORS non autorisées', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/api/v1/health',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' },
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('retourne 404 pour une route inconnue', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/nope' });
    expect(res.statusCode).toBe(404);
  });
});
