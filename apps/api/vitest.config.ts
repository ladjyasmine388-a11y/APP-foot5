import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

try {
  process.loadEnvFile(new URL('../../.env', import.meta.url));
} catch {
  /* pas de .env (CI) : les variables viennent de l'environnement */
}

// Les tests n'utilisent JAMAIS la base de développement.
const testDatabaseUrl =
  process.env['TEST_DATABASE_URL'] ??
  'postgresql://footfive:footfive_dev_password@localhost:5432/footfive_test';

// Le processus principal de Vitest (globalSetup) ne reçoit pas `test.env` : on force l'URL ici aussi,
// pour qu'aucun test ne puisse jamais viser la base de développement chargée depuis .env.
process.env['DATABASE_URL'] = testDatabaseUrl;

const testEnv = {
  NODE_ENV: 'test',
  WEB_ORIGIN: 'http://localhost:5173',
  DATABASE_URL: testDatabaseUrl,
  JWT_ACCESS_SECRET: 'test-only-access-secret-0123456789-abcdef',
  PAYMENT_PROVIDER: 'fake',
  PAYMENT_WEBHOOK_SECRET: 'test-only-webhook-secret-0123456789',
  // Les tests enchaînent beaucoup de requêtes depuis la même IP : on neutralise seulement le filet global.
  GLOBAL_RATE_LIMIT_PER_MINUTE: '100000',
};

// SWC gère les décorateurs NestJS + emitDecoratorMetadata (esbuild ne le fait pas).
const swcPlugin = swc.vite({
  jsc: {
    target: 'es2023',
    parser: { syntax: 'typescript', decorators: true },
    transform: { decoratorMetadata: true, legacyDecorator: true },
  },
});

export default defineConfig({
  plugins: [swcPlugin],
  test: {
    env: testEnv,
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts', 'test/*.test.ts'],
        },
      },
      {
        // Vraie base PostgreSQL : la concurrence et les contraintes ne se testent pas avec des mocks.
        extends: true,
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          globalSetup: ['test/integration/global-setup.ts'],
          // Les fichiers partagent une seule base : on les exécute l'un après l'autre.
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
