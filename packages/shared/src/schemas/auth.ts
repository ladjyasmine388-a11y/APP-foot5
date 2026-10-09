import { z } from 'zod';
import { LOCALES, PLAYER_LEVELS, PLAYER_POSITIONS } from '../enums';
import {
  birthDateSchema,
  citySchema,
  emailSchema,
  firstNameSchema,
  lastNameSchema,
  opaqueTokenSchema,
  passwordSchema,
  phoneSchema,
  preferencesSchema,
} from './primitives';

/**
 * Tous les schémas d'ENTRÉE sont `.strict()` : un champ inconnu (`platformRole`, `emailVerifiedAt`,
 * `passwordHash`…) est REFUSÉ au lieu d'être ignoré. C'est la protection contre l'« assignation de masse » :
 * on ne peut jamais s'octroyer un privilège en ajoutant un champ à la requête.
 */

export const registerSchema = z
  .object({
    firstName: firstNameSchema,
    lastName: lastNameSchema,
    email: emailSchema,
    phone: phoneSchema,
    password: passwordSchema,
    city: citySchema.optional(),
    level: z.enum(PLAYER_LEVELS).default('BEGINNER'),
    preferredPosition: z.enum(PLAYER_POSITIONS).default('ANY'),
    birthDate: birthDateSchema.optional(),
    locale: z.enum(LOCALES).default('fr'),
    /** Consentement explicite aux conditions d'utilisation et à la politique de confidentialité. */
    acceptTerms: z.literal(true, { error: 'Vous devez accepter les conditions d’utilisation' }),
  })
  .strict()
  .refine((v) => v.password.toLowerCase() !== v.email, {
    path: ['password'],
    message: 'Le mot de passe ne doit pas être votre email',
  });
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z
  .object({
    email: emailSchema,
    password: z.string().min(1, 'Mot de passe requis').max(128),
  })
  .strict();
export type LoginInput = z.infer<typeof loginSchema>;

/** Web : le refresh token voyage dans un cookie httpOnly (corps vide). Mobile : dans le corps. */
export const refreshSchema = z.object({ refreshToken: opaqueTokenSchema.optional() }).strict();
export type RefreshInput = z.infer<typeof refreshSchema>;

export const verifyEmailSchema = z.object({ token: opaqueTokenSchema }).strict();
export type VerifyEmailInput = z.infer<typeof verifyEmailSchema>;

export const forgotPasswordSchema = z.object({ email: emailSchema }).strict();
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;

export const resetPasswordSchema = z
  .object({ token: opaqueTokenSchema, password: passwordSchema })
  .strict();
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

export const changePasswordSchema = z
  .object({ currentPassword: z.string().min(1).max(128), newPassword: passwordSchema })
  .strict()
  .refine((v) => v.currentPassword !== v.newPassword, {
    path: ['newPassword'],
    message: 'Le nouveau mot de passe doit être différent de l’ancien',
  });
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

/**
 * Profil modifiable par l'utilisateur lui-même. NE contient volontairement PAS :
 * email (changement = flux de vérification dédié), rôle, statut, fiabilité, avatar (upload dédié).
 */
export const updateProfileSchema = z
  .object({
    firstName: firstNameSchema,
    lastName: lastNameSchema,
    phone: phoneSchema,
    city: citySchema.nullable(),
    level: z.enum(PLAYER_LEVELS),
    preferredPosition: z.enum(PLAYER_POSITIONS),
    birthDate: birthDateSchema.nullable(),
    locale: z.enum(LOCALES),
    preferences: preferencesSchema,
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Aucune modification fournie' });
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

/** La suppression de compte exige le mot de passe : un jeton volé ne suffit pas. */
export const deleteAccountSchema = z.object({ password: z.string().min(1).max(128) }).strict();
export type DeleteAccountInput = z.infer<typeof deleteAccountSchema>;

// ── Réponses ──

export interface PublicUser {
  id: string;
  email: string;
  emailVerified: boolean;
  firstName: string;
  lastName: string;
  phone: string;
  city: string | null;
  level: (typeof PLAYER_LEVELS)[number];
  preferredPosition: (typeof PLAYER_POSITIONS)[number];
  birthDate: string | null;
  avatarUrl: string | null;
  locale: (typeof LOCALES)[number];
  /** Préférences de l'utilisateur lui-même (ex. `emailNotifications`). */
  preferences: Record<string, string | number | boolean>;
  platformRole: 'USER' | 'ADMIN';
  createdAt: string;
}

export interface AuthResponse {
  accessToken: string;
  tokenType: 'Bearer';
  /** Durée de validité du jeton d'accès, en secondes. */
  expiresIn: number;
  /** Présent UNIQUEMENT pour les clients mobiles (en-tête X-Client-Platform: mobile). Le web utilise un cookie httpOnly. */
  refreshToken?: string;
  user: PublicUser;
}

export interface SessionInfo {
  /** Identifiant stable de la session (appareil), à utiliser pour la révoquer. */
  id: string;
  userAgent: string | null;
  ip: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  current: boolean;
}
