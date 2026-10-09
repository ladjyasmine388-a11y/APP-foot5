import { createPgAdapter } from '../src/infra/database/pg-adapter.js';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { seedBaseline } from '../src/infra/database/baseline.js';
import { seedDemo } from './seed-demo.js';

// Le CLI Prisma charge déjà le .env (prisma.config.ts) ; lancé directement (`pnpm db:seed:demo`), on le charge ici.
try {
  process.loadEnvFile(new URL('../../../.env', import.meta.url));
} catch {
  /* pas de .env : les variables viennent de l'environnement */
}

const connectionString = process.env['DATABASE_URL'];
if (!connectionString) throw new Error('DATABASE_URL est requis pour le seed');

const prisma = new PrismaClient({ adapter: createPgAdapter(connectionString) });

try {
  await seedBaseline(prisma);
  console.warn('Seed de base appliqué (paramètres plateforme + commission globale).');
  if (process.argv.includes('--demo')) await seedDemo(prisma);
} finally {
  await prisma.$disconnect();
}
