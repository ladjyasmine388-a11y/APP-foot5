import { HttpStatus, Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import { AppException } from '../../common/errors/app-exception.js';
import { PG_ERROR, isPgError } from '../../infra/database/pg-errors.js';
import { PrismaService } from '../../infra/database/prisma.service.js';
import { generateBookingReference } from './booking-reference.js';

export type NewBooking = Omit<Prisma.BookingUncheckedCreateInput, 'reference'>;

export const slotUnavailable = (details?: unknown): AppException =>
  new AppException(
    'SLOT_UNAVAILABLE',
    HttpStatus.CONFLICT,
    'Ce créneau vient d’être pris, choisissez-en un autre',
    details,
  );

/**
 * SEUL point d'écriture d'une nouvelle réservation (joueur, saisie manuelle du complexe, blocage).
 *
 * Il combine deux garanties :
 *  1. avant d'insérer, les verrous de paiement PÉRIMÉS qui chevauchent la plage passent à EXPIRED. La contrainte
 *     d'exclusion ignore l'horloge : sans cela, un verrou oublié bloquerait le créneau jusqu'au prochain nettoyage ;
 *  2. si deux requêtes visent le même créneau en même temps, la contrainte d'exclusion PostgreSQL en refuse une
 *     (code 23P01), traduite ici en une erreur 409 propre. C'est la base, pas le code, qui garantit l'unicité.
 */
@Injectable()
export class BookingWriter {
  constructor(private readonly prisma: PrismaService) {}

  async create<T extends Prisma.BookingInclude>(
    data: NewBooking,
    include: T,
    options: { now?: Date } = {},
  ): Promise<Prisma.BookingGetPayload<{ include: T }>> {
    const now = options.now ?? new Date();

    const attempt = async (tx: Prisma.TransactionClient) => {
      await tx.booking.updateMany({
        where: {
          fieldId: data.fieldId,
          status: 'PENDING_PAYMENT',
          holdExpiresAt: { lte: now },
          startsAt: { lt: data.endsAt },
          endsAt: { gt: data.startsAt },
        },
        data: { status: 'EXPIRED' },
      });
      // Pas d'`include` ici : Prisma chargerait les relations EN PARALLÈLE sur la connexion de la transaction,
      // ce que le pilote pg déprécie. Les relations sont lues après la transaction.
      return tx.booking.create({
        data: { ...data, reference: generateBookingReference() },
        select: { id: true },
      });
    };

    // La référence est tirée au hasard : en cas (rarissime) de collision on retire une autre référence.
    for (let collisions = 0; ; collisions++) {
      try {
        const { id } = await this.prisma.$transaction(attempt);
        return await this.prisma.booking.findUniqueOrThrow({ where: { id }, include });
      } catch (error) {
        if (isPgError(error, PG_ERROR.EXCLUSION_VIOLATION)) throw slotUnavailable();
        if (isPgError(error, PG_ERROR.UNIQUE_VIOLATION) && collisions < 3) continue;
        throw error;
      }
    }
  }
}
