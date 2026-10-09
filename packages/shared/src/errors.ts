/**
 * Codes d'erreur stables renvoyés par l'API : `{ error: { code, message, details, requestId } }`.
 *
 * Le `message` est un texte de secours en français ; les clients (web, mobile) traduisent à partir
 * du `code` dans la langue de l'utilisateur (ar / fr / en).
 */
export const ERROR_CODES = [
  // Générique
  'VALIDATION_ERROR',
  'NOT_FOUND',
  'FORBIDDEN',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
  'CONFLICT',
  // Authentification
  'UNAUTHENTICATED',
  'INVALID_CREDENTIALS',
  'TOKEN_INVALID',
  'TOKEN_EXPIRED',
  /** Refresh token déjà utilisé : toute la session a été révoquée par précaution. */
  'REFRESH_REUSED',
  /** Deux rafraîchissements simultanés : le client doit réessayer avec le cookie le plus récent. */
  'REFRESH_CONFLICT',
  'ORIGIN_NOT_ALLOWED',
  'EMAIL_TAKEN',
  'EMAIL_NOT_VERIFIED',
  'ACCOUNT_BLOCKED',
  'INVALID_CURRENT_PASSWORD',
  // Compte
  'ACCOUNT_HAS_UPCOMING_BOOKINGS',
  'ACCOUNT_IS_TEAM_CAPTAIN',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown;
    requestId?: string;
  };
}

export interface FieldIssue {
  /** Chemin du champ, ex. "password" ou "preferences.theme". */
  path: string;
  message: string;
  code: string;
}
