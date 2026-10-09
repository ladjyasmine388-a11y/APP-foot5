import { defineConfig } from 'prisma/config';

// Charge le .env racine (Node >= 22). N'écrase jamais une variable déjà définie (CI, production, tests).
try {
  process.loadEnvFile(new URL('../../.env', import.meta.url));
} catch {
  /* pas de .env : les variables viennent de l'environnement */
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url: process.env['DATABASE_URL'] ?? '',
  },
});
