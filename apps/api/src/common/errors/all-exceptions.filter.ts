import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { ApiErrorBody, ErrorCode } from '@footfive/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { AppException } from './app-exception.js';
import { formatZodIssues } from '../zod/zod-validation.pipe.js';

const STATUS_TO_CODE: Record<number, ErrorCode> = {
  400: 'VALIDATION_ERROR',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  413: 'VALIDATION_ERROR',
  415: 'VALIDATION_ERROR',
  429: 'RATE_LIMITED',
};

const STATUS_TO_MESSAGE: Record<number, string> = {
  400: 'Requête invalide',
  401: 'Authentification requise',
  403: 'Accès refusé',
  404: 'Ressource introuvable',
  409: 'Conflit avec l’état actuel de la ressource',
  413: 'Requête trop volumineuse',
  415: 'Type de contenu non supporté',
  429: 'Trop de requêtes, réessayez plus tard',
};

/**
 * Transforme TOUTE erreur en `{ error: { code, message, details?, requestId } }`.
 * Les erreurs inattendues (500) ne divulguent jamais leur détail : il est journalisé avec le requestId.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Http');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const reply = http.getResponse<FastifyReply>();
    const request = http.getRequest<FastifyRequest>();
    const requestId = String(request.id);

    let status: number = HttpStatus.INTERNAL_SERVER_ERROR;
    let code: ErrorCode = 'INTERNAL_ERROR';
    let message = 'Une erreur interne est survenue';
    let details: unknown;
    let headers: Record<string, string> | undefined;

    if (exception instanceof AppException) {
      status = exception.getStatus();
      code = exception.code;
      message = (exception.getResponse() as { message: string }).message;
      details = exception.details;
      headers = exception.headers;
    } else if (exception instanceof ZodError) {
      status = HttpStatus.BAD_REQUEST;
      code = 'VALIDATION_ERROR';
      message = 'Données invalides';
      details = formatZodIssues(exception);
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      code = STATUS_TO_CODE[status] ?? (status >= 500 ? 'INTERNAL_ERROR' : 'CONFLICT');
      message = STATUS_TO_MESSAGE[status] ?? message;
    } else if (isFastifyClientError(exception)) {
      // Erreurs du serveur HTTP lui-même : JSON malformé, corps trop gros, type de contenu inconnu…
      status = exception.statusCode;
      code = STATUS_TO_CODE[status] ?? 'VALIDATION_ERROR';
      message = STATUS_TO_MESSAGE[status] ?? 'Requête invalide';
    }

    if (status >= 500) {
      this.logger.error(
        `[${requestId}] ${request.method} ${request.url} → ${status}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    const body: ApiErrorBody = {
      error: { code, message, ...(details === undefined ? {} : { details }), requestId },
    };
    void reply
      .status(status)
      .headers(headers ?? {})
      .send(body);
  }
}

function isFastifyClientError(error: unknown): error is { statusCode: number } {
  if (typeof error !== 'object' || error === null) return false;
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  return typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500;
}
