import { Test } from '@nestjs/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../../src/app.module.js';
import { NEST_APP_OPTIONS, configureApp, createAdapter } from '../../src/app.setup.js';
import { loadEnv } from '../../src/infra/config/env.js';
import {
  BASELINE_SETTINGS,
  DEFAULT_GLOBAL_COMMISSION_BPS,
  seedBaseline,
} from '../../src/infra/database/baseline.js';
import { clearGlobalConfig, prisma, resetDb } from './helpers.js';

describe('GET /api/v1/health/ready', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(
      createAdapter(),
      NEST_APP_OPTIONS,
    );
    await configureApp(app, loadEnv());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('répond 200 quand la base de données est joignable', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/health/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', database: 'up' });
  });
});

describe('seed de base (valeurs par défaut de la plateforme)', () => {
  beforeAll(resetDb);
  beforeEach(clearGlobalConfig);

  it('crée la commission globale de 1 % (100 points de base) et les paramètres', async () => {
    await seedBaseline(prisma);

    const rules = await prisma.commissionRule.findMany({ where: { scope: 'GLOBAL' } });
    expect(rules).toHaveLength(1);
    expect(rules[0]?.rateBps).toBe(DEFAULT_GLOBAL_COMMISSION_BPS);
    expect(DEFAULT_GLOBAL_COMMISSION_BPS).toBe(100);

    const settings = await prisma.platformSetting.findMany();
    expect(settings.map((s) => s.key).sort()).toEqual(Object.keys(BASELINE_SETTINGS).sort());
  });

  it('est idempotent : le rejouer ne crée pas de doublon', async () => {
    await seedBaseline(prisma);
    await seedBaseline(prisma);
    expect(await prisma.commissionRule.count()).toBe(1);
    expect(await prisma.platformSetting.count()).toBe(Object.keys(BASELINE_SETTINGS).length);
  });

  it('n’écrase jamais une valeur déjà modifiée par l’admin', async () => {
    await seedBaseline(prisma);
    await prisma.platformSetting.update({
      where: { key: 'booking.hold_minutes' },
      data: { value: 15 },
    });
    const rule = await prisma.commissionRule.findFirstOrThrow({ where: { scope: 'GLOBAL' } });
    await prisma.commissionRule.update({ where: { id: rule.id }, data: { rateBps: 250 } });

    await seedBaseline(prisma);

    expect(
      (await prisma.platformSetting.findUniqueOrThrow({ where: { key: 'booking.hold_minutes' } }))
        .value,
    ).toBe(15);
    expect(
      (await prisma.commissionRule.findFirstOrThrow({ where: { scope: 'GLOBAL' } })).rateBps,
    ).toBe(250);
  });
});
