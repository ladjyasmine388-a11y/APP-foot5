import { HttpException, HttpStatus } from '@nestjs/common';
import type { ErrorCode } from '@footfive/shared';

/**
 * Erreur métier avec un code STABLE (que les clients traduisent) et un message de secours en français.
 * Toujours sérialisée par AllExceptionsFilter sous la forme `{ error: { code, message, details, requestId } }`.
 */
export class AppException extends HttpException {
  constructor(
    readonly code: ErrorCode,
    status: number,
    message: string,
    readonly details?: unknown,
    readonly headers?: Record<string, string>,
  ) {
    super({ code, message, details }, status);
  }
}

/** Fabriques d'erreurs courantes : un seul endroit pour les messages et les statuts HTTP. */
export const Errors = {
  unauthenticated: (message = 'Authentification requise') =>
    new AppException('UNAUTHENTICATED', HttpStatus.UNAUTHORIZED, message),
  invalidCredentials: () =>
    new AppException(
      'INVALID_CREDENTIALS',
      HttpStatus.UNAUTHORIZED,
      'Email ou mot de passe incorrect',
    ),
  tokenInvalid: () => new AppException('TOKEN_INVALID', HttpStatus.UNAUTHORIZED, 'Jeton invalide'),
  tokenExpired: () => new AppException('TOKEN_EXPIRED', HttpStatus.UNAUTHORIZED, 'Jeton expiré'),
  refreshReused: () =>
    new AppException(
      'REFRESH_REUSED',
      HttpStatus.UNAUTHORIZED,
      'Session révoquée par sécurité : veuillez vous reconnecter',
    ),
  refreshConflict: () =>
    new AppException(
      'REFRESH_CONFLICT',
      HttpStatus.UNAUTHORIZED,
      'Rafraîchissement simultané : réessayez avec le jeton le plus récent',
    ),
  originNotAllowed: () =>
    new AppException('ORIGIN_NOT_ALLOWED', HttpStatus.FORBIDDEN, 'Origine non autorisée'),
  emailTaken: () =>
    new AppException('EMAIL_TAKEN', HttpStatus.CONFLICT, 'Un compte existe déjà avec cet email'),
  emailNotVerified: () =>
    new AppException('EMAIL_NOT_VERIFIED', HttpStatus.FORBIDDEN, 'Veuillez vérifier votre email'),
  accountBlocked: () =>
    new AppException('ACCOUNT_BLOCKED', HttpStatus.FORBIDDEN, 'Ce compte est suspendu'),
  forbidden: (message = 'Accès refusé') =>
    new AppException('FORBIDDEN', HttpStatus.FORBIDDEN, message),
  notFound: (message = 'Ressource introuvable') =>
    new AppException('NOT_FOUND', HttpStatus.NOT_FOUND, message),
  invalidCurrentPassword: () =>
    new AppException(
      'INVALID_CURRENT_PASSWORD',
      HttpStatus.FORBIDDEN,
      'Mot de passe actuel incorrect',
    ),
  rateLimited: (retryAfterSeconds: number) =>
    new AppException(
      'RATE_LIMITED',
      HttpStatus.TOO_MANY_REQUESTS,
      'Trop de tentatives, réessayez plus tard',
      { retryAfterSeconds },
      { 'Retry-After': String(retryAfterSeconds) },
    ),
};
