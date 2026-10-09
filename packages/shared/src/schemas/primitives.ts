import { z } from 'zod';

/** Chiffres arabo-indiens (٠-٩) et persans (۰-۹) → ASCII. Les utilisateurs arabophones les tapent naturellement. */
export function toAsciiDigits(input: string): string {
  return input
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}

/**
 * Normalise un numéro de téléphone au format international E.164.
 * - `0550 12 34 56`, `0550-12-34-56`, `٠٥٥٠١٢٣٤٥٦` → `+213550123456`
 * - `00213 550 12 34 56` → `+213550123456`
 * - `+213 550 12 34 56` → `+213550123456`
 * Retourne `null` si le résultat n'est pas un numéro plausible.
 */
export function normalizePhone(input: string): string | null {
  let value = toAsciiDigits(input).replace(/[\s().-]/g, '');
  if (value.startsWith('00')) value = `+${value.slice(2)}`;
  // Numéro national algérien : 0 + 8 ou 9 chiffres.
  if (/^0\d{8,9}$/.test(value)) value = `+213${value.slice(1)}`;
  return /^\+[1-9]\d{7,14}$/.test(value) ? value : null;
}

export const phoneSchema = z
  .string()
  .trim()
  .min(1, 'Numéro de téléphone requis')
  .max(30)
  .transform((value, ctx) => {
    const normalized = normalizePhone(value);
    if (!normalized) {
      ctx.addIssue({ code: 'custom', message: 'Numéro de téléphone invalide' });
      return z.NEVER;
    }
    return normalized;
  });

/** Email normalisé : espaces retirés, minuscules (le SQL impose aussi des minuscules). */
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .pipe(z.email('Adresse email invalide'));

/** Mots de passe trop courants, refusés quelle que soit leur longueur. */
const COMMON_PASSWORDS = new Set([
  'password12',
  'password123',
  'password1234',
  '1234567890',
  '12345678910',
  'azertyuiop',
  'azerty12345',
  'qwertyuiop',
  'motdepasse',
  'motdepasse1',
  'footfive123',
  'footballfive',
]);

export const passwordSchema = z
  .string()
  .min(10, 'Le mot de passe doit contenir au moins 10 caractères')
  .max(128, 'Le mot de passe est trop long (128 caractères maximum)')
  .refine((value) => !COMMON_PASSWORDS.has(value.toLowerCase()), 'Mot de passe trop courant')
  .refine((value) => new Set(value).size >= 5, 'Mot de passe trop répétitif');

const personNameSchema = z
  .string()
  .trim()
  .min(1, 'Champ requis')
  .max(60)
  // Interdit les caractères de contrôle ; accepte lettres de toutes langues, espaces, apostrophes, traits d'union.
  .regex(/^[\p{L}\p{M}][\p{L}\p{M}\s'’.-]*$/u, 'Caractères non autorisés');

export const firstNameSchema = personNameSchema;
export const lastNameSchema = personNameSchema;

const MIN_AGE_YEARS = 13;

/** Date de naissance `AAAA-MM-JJ`, âge minimal 13 ans. */
export const birthDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Format attendu : AAAA-MM-JJ')
  .refine((value) => {
    const date = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) return false;
    const limit = new Date();
    limit.setUTCFullYear(limit.getUTCFullYear() - MIN_AGE_YEARS);
    return date.getUTCFullYear() >= 1900 && date <= limit;
  }, `Date de naissance invalide (âge minimal : ${MIN_AGE_YEARS} ans)`);

export const citySchema = z.string().trim().min(1).max(80);

/** Préférences libres, bornées : jamais de structure imbriquée ni de volume excessif. */
export const preferencesSchema = z
  .record(z.string().max(40), z.union([z.string().max(200), z.number(), z.boolean()]))
  .refine((value) => Object.keys(value).length <= 20, 'Trop de préférences (20 maximum)');

/** Jeton opaque (email de vérification, réinitialisation, refresh token). */
export const opaqueTokenSchema = z.string().min(20).max(200);
