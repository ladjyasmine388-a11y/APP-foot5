import { describe, expect, it } from 'vitest';
import { AppException } from '../../common/errors/app-exception.js';
import { type Env, loadEnv } from '../../infra/config/env.js';
import { FakeProviderOnlyGuard } from './fake-provider-dev.controller.js';
import { FakePaymentProvider } from './providers/fake-payment.provider.js';

const base = {
  NODE_ENV: 'test',
  WEB_ORIGIN: 'http://localhost:5173',
  DATABASE_URL: 'postgresql://u:p@localhost:5432/x_test',
  JWT_ACCESS_SECRET: 'unit-test-secret-with-more-than-32-characters',
  PAYMENT_WEBHOOK_SECRET: 'unit-test-webhook-secret-123456',
};
const envOf = (overrides: Record<string, string> = {}): Env => loadEnv({ ...base, ...overrides });

describe('routes de paiement simulé (développement uniquement)', () => {
  it('sont ouvertes avec le prestataire simulé hors production', () => {
    const env = envOf();
    expect(new FakeProviderOnlyGuard(env, new FakePaymentProvider(env)).canActivate()).toBe(true);
  });

  it('répondent 404 en production, même si le prestataire simulé existait', () => {
    // La validation d'environnement refuse déjà « fake » en production : on construit l'objet à la main
    // pour vérifier que le garde, LUI AUSSI, referme les routes (double verrou).
    const env = { ...envOf(), NODE_ENV: 'production' } as Env;
    const guard = new FakeProviderOnlyGuard(env, new FakePaymentProvider(env));
    expect(() => guard.canActivate()).toThrow(AppException);
  });

  it('répondent 404 quand le prestataire réel est configuré', () => {
    const env = envOf({ PAYMENT_PROVIDER: 'live' });
    expect(() => new FakeProviderOnlyGuard(env, null).canActivate()).toThrow(AppException);
  });

  it('répondent 404 si aucun prestataire simulé n’est instancié', () => {
    expect(() => new FakeProviderOnlyGuard(envOf(), null).canActivate()).toThrow(AppException);
  });
});
