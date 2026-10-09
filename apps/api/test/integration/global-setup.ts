import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

/**
 * Applique les migrations sur la base de TEST avant les tests d'intégration.
 * Échoue clairement si la base est injoignable (on ne "saute" jamais ces tests en silence).
 */
export default function setup(): void {
  const url = process.env['DATABASE_URL'];
  if (!url || !/\/[^/?]*_test(\?|$)/.test(url)) {
    throw new Error(
      `Refus : les tests d'intégration exigent une base dont le nom finit par "_test" (reçu : ${url})`,
    );
  }
  const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js');
  try {
    execFileSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
      env: { ...process.env, DATABASE_URL: url },
      stdio: 'pipe',
    });
  } catch (error) {
    const out = error as { stdout?: Buffer; stderr?: Buffer };
    throw new Error(
      `Impossible d'appliquer les migrations sur la base de test.\n${out.stdout?.toString() ?? ''}${out.stderr?.toString() ?? ''}\n` +
        `Vérifiez que PostgreSQL tourne et que la base footfive_test existe (scripts/db/setup-local.sql).`,
      { cause: error },
    );
  }
}
