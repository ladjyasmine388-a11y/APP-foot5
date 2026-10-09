import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Jeton opaque : 256 bits d'aléa, encodé en base64url (43 caractères). */
export function generateOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Empreinte SHA-256 d'un jeton. On ne stocke JAMAIS un jeton en clair : une fuite de la base
 * ne permet pas de se connecter. SHA-256 suffit (et non Argon2) car le jeton a 256 bits d'entropie.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
