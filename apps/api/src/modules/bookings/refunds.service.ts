import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';

/**
 * Demandes de remboursement liées à une annulation.
 *
 * Ce service crée uniquement des demandes (`Refund` au statut REQUESTED), DANS la transaction d'annulation :
 * la réservation est annulée ET la demande enregistrée, ou rien. L'exécution auprès du prestataire de paiement
 * (appel API, suivi, webhook) est faite par le module de paiement (étape 6).
 */
@Injectable()
export class RefundsService {
  /**
   * Demande le remboursement de TOUT ce qui a été payé en ligne et pas déjà remboursé (ou en cours de l'être).
   * Retourne le montant total demandé.
   */
  async requestFullRefund(
    tx: Prisma.TransactionClient,
    args: { bookingId: string; reason: string; requestedById: string | null },
  ): Promise<number> {
    const payments = await tx.payment.findMany({
      where: { bookingId: args.bookingId, status: { in: ['SUCCEEDED', 'PARTIALLY_REFUNDED'] } },
      select: {
        id: true,
        amountMinor: true,
        refunds: {
          where: { status: { notIn: ['REJECTED', 'FAILED'] } },
          select: { amountMinor: true },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    let requested = 0;
    for (const payment of payments) {
      const alreadyRefunded = payment.refunds.reduce((sum, r) => sum + r.amountMinor, 0);
      const remaining = payment.amountMinor - alreadyRefunded;
      if (remaining <= 0) continue;
      await tx.refund.create({
        data: {
          paymentId: payment.id,
          bookingId: args.bookingId,
          amountMinor: remaining,
          reason: args.reason,
          requestedById: args.requestedById,
          status: 'REQUESTED',
        },
      });
      requested += remaining;
    }
    return requested;
  }
}
