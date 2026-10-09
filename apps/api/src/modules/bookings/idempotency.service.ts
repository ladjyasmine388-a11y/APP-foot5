import { HttpStatus, Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import { AppException } from '../../common/errors/app-exception.js';
import { PG_ERROR, isPgError } from '../../infra/database/pg-errors.js';
import { PrismaService } from '../../infra/database/prisma.service.js';
import { hashToken } from '../../infra/security/crypto.js';

const KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const KEY_TTL_MS = 24 * 60 * 60 * 1000;
/** Une requête « en cours » sans réponse depuis plus longtemps que ça est considérée comme abandonnée (plantage). */
const STALE_IN_PROGRESS_MS = 2 * 60 * 1000;

export interface IdempotentResult<T> {
  status: number;
  body: T;
  /** Vrai si la réponse a été rejouée depuis une exécution précédente (rien n'a été refait). */
  replayed: boolean;
}

/** Valide l'en-tête `Idempotency-Key` (obligatoire sur les routes qui créent un engagement financier). */
export function parseIdempotencyKey(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value || !KEY_PATTERN.test(value)) {
    throw new AppException(
      'VALIDATION_ERROR',
      HttpStatus.BAD_REQUEST,
      'En-tête Idempotency-Key requis (8 à 128 caractères : lettres, chiffres, _ ou -)',
      [
        {
          path: 'Idempotency-Key',
          message: 'Requis, 8 à 128 caractères [A-Za-z0-9_-]',
          code: 'invalid_header',
        },
      ],
    );
  }
  return value;
}

/** JSON à clés triées : deux corps équivalents donnent la même empreinte, quel que soit l'ordre des champs. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Idempotence des requêtes sensibles : rejouer EXACTEMENT la même requête (double clic, coupure réseau,
 * nouvelle tentative automatique) ne crée jamais un second engagement ; on renvoie la réponse du premier appel.
 *
 *  - même clé + même contenu → réponse rejouée ;
 *  - même clé + contenu différent → 422 (la clé est liée à UNE requête précise) ;
 *  - même clé pendant que la première requête s'exécute encore → 409 ;
 *  - échec → la clé est libérée : le client peut réessayer (rien n'a été créé).
 */
@Injectable()
export class IdempotencyService {
  constructor(private readonly prisma: PrismaService) {}

  async execute<T extends Prisma.InputJsonValue>(
    args: { userId: string; key: string; endpoint: string; body: unknown },
    run: () => Promise<{ status: number; body: T }>,
  ): Promise<IdempotentResult<T>> {
    const requestHash = hashToken(canonicalJson(args.body));
    const where = {
      userId_key_endpoint: { userId: args.userId, key: args.key, endpoint: args.endpoint },
    };

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const claim = await this.prisma.idempotencyKey.create({
          data: {
            userId: args.userId,
            key: args.key,
            endpoint: args.endpoint,
            requestHash,
            expiresAt: new Date(Date.now() + KEY_TTL_MS),
          },
        });
        return await this.runAndStore(claim.id, run);
      } catch (error) {
        if (!isPgError(error, PG_ERROR.UNIQUE_VIOLATION)) throw error;
      }

      // La clé existe déjà : rejouer, refuser, ou reprendre une exécution abandonnée.
      const existing = await this.prisma.idempotencyKey.findUnique({ where });
      if (!existing) continue; // supprimée entre-temps (échec de la 1re requête) : on retente
      if (existing.requestHash !== requestHash) {
        throw new AppException(
          'IDEMPOTENCY_KEY_REUSED',
          HttpStatus.UNPROCESSABLE_ENTITY,
          'Cette Idempotency-Key a déjà servi pour une requête différente',
        );
      }
      if (existing.responseStatus !== null) {
        return {
          status: existing.responseStatus,
          body: existing.responseBody as T,
          replayed: true,
        };
      }
      if (Date.now() - existing.createdAt.getTime() > STALE_IN_PROGRESS_MS) {
        await this.prisma.idempotencyKey.deleteMany({
          where: { id: existing.id, responseStatus: null },
        });
        continue;
      }
      throw new AppException(
        'REQUEST_IN_PROGRESS',
        HttpStatus.CONFLICT,
        'Une requête identique est déjà en cours de traitement',
      );
    }
    throw new AppException(
      'REQUEST_IN_PROGRESS',
      HttpStatus.CONFLICT,
      'Requête concurrente, réessayez',
    );
  }

  private async runAndStore<T extends Prisma.InputJsonValue>(
    claimId: string,
    run: () => Promise<{ status: number; body: T }>,
  ): Promise<IdempotentResult<T>> {
    let result: { status: number; body: T };
    try {
      result = await run();
    } catch (error) {
      // Rien n'a été créé : on libère la clé pour qu'une nouvelle tentative soit possible.
      await this.prisma.idempotencyKey.delete({ where: { id: claimId } }).catch(() => undefined);
      throw error;
    }
    await this.prisma.idempotencyKey.update({
      where: { id: claimId },
      data: { responseStatus: result.status, responseBody: result.body },
    });
    return { ...result, replayed: false };
  }

  /** Supprime les clés expirées (appelé par la maintenance périodique). */
  async purgeExpired(now: Date = new Date()): Promise<number> {
    const { count } = await this.prisma.idempotencyKey.deleteMany({
      where: { expiresAt: { lte: now } },
    });
    return count;
  }
}
