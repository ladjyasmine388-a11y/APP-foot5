import { createPgAdapter } from '../src/infra/database/pg-adapter.js';
import { PrismaClient } from '../src/generated/prisma/client.js';

/**
 * Désigne un administrateur de la plateforme : `pnpm --filter @footfive/api db:create-admin -- email@exemple.com`.
 *
 * Le compte doit EXISTER, être ACTIF et avoir un email VÉRIFIÉ : la personne s'inscrit d'abord normalement (aucun mot de passe
 * ne transite par ce script). Il n'existe volontairement aucune route d'API pour s'octroyer ce rôle.
 * L'opération est tracée dans le journal d'audit (acteur « SYSTEM »).
 */
try {
  process.loadEnvFile(new URL('../../../.env', import.meta.url));
} catch {
  /* pas de .env : les variables viennent de l'environnement */
}

async function main(): Promise<void> {
  const email = process.argv
    .slice(2)
    .find((arg) => !arg.startsWith('-'))
    ?.trim()
    .toLowerCase();
  const connectionString = process.env['DATABASE_URL'];
  if (!email) throw new Error('Usage : db:create-admin -- email@exemple.com');
  if (!connectionString) throw new Error('DATABASE_URL est requis');

  const prisma = new PrismaClient({ adapter: createPgAdapter(connectionString) });
  try {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user)
      throw new Error(
        `Aucun compte avec l'adresse ${email} : la personne doit d'abord s'inscrire.`,
      );
    if (user.status !== 'ACTIVE')
      throw new Error(
        `Le compte est « ${user.status} » : impossible d'en faire un administrateur.`,
      );
    if (!user.emailVerifiedAt)
      throw new Error(
        "L'adresse email du compte n'est pas vérifiée : demandez-lui de confirmer son email d'abord.",
      );
    if (user.platformRole === 'ADMIN') {
      console.warn(`${email} est déjà administrateur.`);
    } else {
      await prisma.$transaction([
        prisma.user.update({ where: { id: user.id }, data: { platformRole: 'ADMIN' } }),
        prisma.auditLog.create({
          data: {
            actorRole: 'SYSTEM',
            action: 'user.promote_admin',
            entityType: 'User',
            entityId: user.id,
            before: { platformRole: user.platformRole },
            after: { platformRole: 'ADMIN' },
          },
        }),
      ]);
      console.warn(`${email} est maintenant administrateur.`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
