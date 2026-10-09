// Démarre l'API pour les tests de bout en bout sur une base DÉDIÉE, remise à zéro puis alimentée avec les données de démonstration.
// Garde-fou : refuse de vider une base dont le nom ne se termine pas par `_test` ou `_e2e`.
import { spawnSync } from 'node:child_process';
import pg from 'pg';

const databaseUrl =
  process.env.E2E_DATABASE_URL ??
  process.env.TEST_DATABASE_URL ??
  'postgresql://footfive:footfive_dev_password@localhost:5432/footfive_test';

if (!/\/[^/?]*_(test|e2e)(\?|$)/.test(databaseUrl)) {
  console.error(
    `Refus de vider une base qui n'est pas une base de test : ${databaseUrl.replace(/:[^:@/]*@/, ':***@')}`,
  );
  process.exit(1);
}

const env = { ...process.env, DATABASE_URL: databaseUrl };
const run = (args) => {
  const result = spawnSync('pnpm', args, { env, stdio: 'inherit', shell: true });
  if (result.status !== 0) process.exit(result.status ?? 1);
};

console.log('[e2e] migrations…');
run(['--filter', '@footfive/api', 'exec', 'prisma', 'migrate', 'deploy']);

console.log('[e2e] remise à zéro de la base…');
const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();
const { rows } = await client.query(
  "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'",
);
if (rows.length > 0) {
  const names = rows.map((r) => `"${String(r.tablename).replaceAll('"', '""')}"`).join(', ');
  await client.query(`TRUNCATE ${names} RESTART IDENTITY CASCADE`);
}
await client.end();

console.log('[e2e] données de démonstration…');
run(['--filter', '@footfive/api', 'db:seed:demo']);

Object.assign(process.env, {
  DATABASE_URL: databaseUrl,
  NODE_ENV: 'development',
  API_PORT: process.env.E2E_API_PORT ?? '3100',
  WEB_ORIGIN: process.env.E2E_WEB_ORIGIN ?? 'http://localhost:5174',
  API_PUBLIC_URL: `http://localhost:${process.env.E2E_API_PORT ?? '3100'}`,
  JWT_ACCESS_SECRET: 'e2e-only-access-secret-0123456789-abcdef-ghij',
  PAYMENT_PROVIDER: 'fake',
  PAYMENT_WEBHOOK_SECRET: 'e2e-only-webhook-secret-0123456789-abcdef',
  MAIL_DRIVER: 'console',
  GLOBAL_RATE_LIMIT_PER_MINUTE: '100000',
  STORAGE_LOCAL_DIR: '.cache/e2e-storage',
});

console.log('[e2e] démarrage de l’API…');
await import('../../apps/api/dist/main.js');
