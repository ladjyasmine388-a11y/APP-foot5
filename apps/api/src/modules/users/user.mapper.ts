import type { Locale, PublicUser } from '@footfive/shared';
import type { User } from '../../generated/prisma/client.js';

/**
 * Seul chemin de sortie d'un utilisateur vers l'extérieur : liste BLANCHE de champs.
 * Ajouter une colonne sensible à `User` ne la fait donc jamais fuiter dans l'API par accident
 * (passwordHash, statut interne, indicateurs de fiabilité…).
 */
export function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    email: user.email,
    emailVerified: user.emailVerifiedAt !== null,
    firstName: user.firstName,
    lastName: user.lastName,
    phone: user.phone,
    city: user.city,
    level: user.level,
    preferredPosition: user.preferredPosition,
    birthDate: user.birthDate ? user.birthDate.toISOString().slice(0, 10) : null,
    avatarUrl: user.avatarUrl,
    locale: user.locale as Locale,
    platformRole: user.platformRole,
    createdAt: user.createdAt.toISOString(),
  };
}
