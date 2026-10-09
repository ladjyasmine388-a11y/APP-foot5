import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { seedBaseline } from '../src/infra/database/baseline.js';

// Le CLI Prisma charge déjà le .env (prisma.config.ts) avant d'appeler ce script.
const connectionString = process.env['DATABASE_URL'];
if (!connectionString) throw new Error('DATABASE_URL est requis pour le seed');

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

try {
  await seedBaseline(prisma);
  console.warn('Seed de base appliqué (paramètres plateforme + commission globale).');
} finally {
  await prisma.$disconnect();
}
