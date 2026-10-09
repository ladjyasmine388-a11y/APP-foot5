import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';

export interface RefundRequestResult {
  totalMinor: number;
  refundIds: string[];
}

/**
 * Demandes de remboursement. Ce service crée uniquement des `Refund` au statut REQUESTED, DANS la transaction de
 * l'action qui les motive (annulation, paiement en double…) : l'action et la demande sont enregistrées ensemble,
 * ou pas du tout. L'exécution auprès du prestataire de paiement est faite ensuite par le module de paiement.
 */
@Injectable()
export class RefundsService {
  /** Demande le remboursement de TOUT ce qui a été payé pour une réservation et pas déjà remboursé (ou en cours). */
  async requestFullRefund(
    tx: Prisma.TransactionClient,
    args: { bookingId: string; reason: string; requestedById: string | null },
  ): Promise<RefundRequestResult> {
    const payments = await tx.payment.findMany({
      where: { bookingId: args.bookingId, status: { in: ['SUCCEEDED', 'PARTIALLY_REFUNDED'] } },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });
    const result: RefundRequestResult = { totalMinor: 0, refundIds: [] };
    for (const payment of payments) {
      const created = await this.requestForPayment(tx, { ...args, paymentId: payment.id });
      result.totalMinor += created.totalMinor;
      result.refundIds.push(...created.refundIds);
    }
    return result;
  }

  /** Demande le remboursement du solde restant d'UN paiement précis (ex. paiement en double). */
  async requestForPayment(
    tx: Prisma.TransactionClient,
    args: { paymentId: string; bookingId: string; reason: string; requestedById: string | null },
  ): Promise<RefundRequestResult> {
    const payment = await tx.payment.findUniqueOrThrow({
      where: { id: args.paymentId },
      select: {
        amountMinor: true,
        refunds: {
          where: { status: { notIn: ['REJECTED', 'FAILED'] } },
          select: { amountMinor: true },
        },
      },
    });
    const alreadyRefunded = payment.refunds.reduce((sum, r) => sum + r.amountMinor, 0);
    const remaining = payment.amountMinor - alreadyRefunded;
    if (remaining <= 0) return { totalMinor: 0, refundIds: [] };

    const refund = await tx.refund.create({
      data: {
        paymentId: args.paymentId,
        bookingId: args.bookingId,
        amountMinor: remaining,
        reason: args.reason,
        requestedById: args.requestedById,
        status: 'REQUESTED',
      },
      select: { id: true },
    });
    return { totalMinor: remaining, refundIds: [refund.id] };
  }
}
