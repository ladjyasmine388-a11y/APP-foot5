import { HttpStatus, Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { PaymentView } from '@footfive/shared';
import type { Payment } from '../../generated/prisma/client.js';
import { AppException, Errors } from '../../common/errors/app-exception.js';
import { ENV } from '../../infra/config/config.module.js';
import type { Env } from '../../infra/config/env.js';
import { PG_ERROR, isPgError } from '../../infra/database/pg-errors.js';
import { PrismaService } from '../../infra/database/prisma.service.js';
import { DomainEvents } from '../../infra/events/domain-events.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { effectiveStatus } from '../bookings/booking.mappers.js';
import { RefundsService } from '../bookings/refunds.service.js';
import { SettingsService } from '../settings/settings.service.js';
import {
  PaymentProvider,
  PaymentProviderError,
  type ProviderPaymentState,
} from './providers/payment-provider.js';

/** Résultat de l'application d'un état du prestataire à un paiement. */
export type ApplyOutcome = 'APPLIED' | 'IGNORED' | 'MISMATCH';

/** Un paiement « initialisé » depuis plus longtemps que ça n'aboutira plus (création abandonnée). */
const STALE_INITIATED_MS = 30_000;
/** Le verrou de paiement peut être prolongé pendant le règlement, au plus jusqu'à ce multiple de sa durée de base. */
const MAX_HOLD_MULTIPLE = 3;

const OPEN_STATUSES = ['INITIATED', 'PENDING'] as const;

const notPayable = (message: string): AppException =>
  new AppException('BOOKING_NOT_PAYABLE', HttpStatus.CONFLICT, message);

export function toPaymentView(p: Payment): PaymentView {
  const open = p.status === 'INITIATED' || p.status === 'PENDING';
  return {
    id: p.id,
    bookingId: p.bookingId,
    status: p.status,
    kind: p.kind,
    amountMinor: p.amountMinor,
    currency: 'DZD',
    // Ni la référence du prestataire ni sa réponse brute ne sortent de l'API.
    checkoutUrl: open ? p.checkoutUrl : null,
    paidAt: p.paidAt?.toISOString() ?? null,
    failureReason: p.failureReason,
    createdAt: p.createdAt.toISOString(),
  };
}

/**
 * Paiements des réservations.
 *
 * RÈGLE D'OR : un paiement n'est « réussi » que lorsque le SERVEUR l'a confirmé auprès du prestataire
 * (`provider.getPaymentState`, appel de serveur à serveur). Ni la redirection du navigateur vers notre page de
 * retour, ni le contenu d'un webhook ne suffisent : le webhook (authentifié par signature) sert de DÉCLENCHEUR,
 * la vérité vient d'une requête que nous émettons nous-mêmes.
 */
@Injectable()
export class PaymentsService implements OnModuleInit {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly provider: PaymentProvider,
    private readonly settings: SettingsService,
    private readonly refunds: RefundsService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    @Inject(ENV) private readonly env: Env,
  ) {}

  onModuleInit(): void {
    this.events.on('booking.cancelled', ({ bookingId }) => this.cancelPendingForBooking(bookingId));
    this.events.on('booking.expired', async ({ bookingIds }) => {
      for (const bookingId of bookingIds) await this.cancelPendingForBooking(bookingId);
    });
    this.events.on('refund.requested', async ({ refundIds }) => {
      for (const refundId of refundIds) await this.processRefund(refundId);
    });
  }

  // ───────────────────────── Lancer un paiement ─────────────────────────

  /**
   * Ouvre le paiement de l'acompte (ou du total) d'une réservation en attente. Le client n'envoie AUCUN montant :
   * c'est celui figé dans la réservation. Une seule demande de paiement peut être en cours par réservation
   * (contrainte de base) : relancer renvoie la même page de paiement.
   */
  async initiate(
    user: AuthUser,
    bookingId: string,
    idempotencyKey: string,
    now: Date = new Date(),
  ): Promise<PaymentView> {
    const booking = await this.prisma.booking.findFirst({
      where: { id: bookingId, userId: user.id, bookingType: { not: 'BLOCK' } },
      include: {
        venue: { select: { name: true } },
        customer: { select: { email: true, phone: true } },
      },
    });
    if (!booking || !booking.customer) throw Errors.notFound('Réservation introuvable');

    const status = effectiveStatus(booking, now);
    if (status !== 'PENDING_PAYMENT') {
      throw notPayable(
        status === 'EXPIRED'
          ? 'Le délai de paiement est dépassé : refaites votre réservation'
          : 'Cette réservation ne peut plus être payée',
      );
    }
    if (booking.dueOnlineMinor <= 0)
      throw notPayable('Rien à payer en ligne pour cette réservation');

    // Un paiement déjà ouvert : on rend la même page de paiement (jamais deux en parallèle).
    const open = await this.openPayment(bookingId);
    if (open) {
      if (open.status === 'PENDING' && open.checkoutUrl) return toPaymentView(open);
      if (now.getTime() - open.createdAt.getTime() < STALE_INITIATED_MS) {
        throw new AppException(
          'REQUEST_IN_PROGRESS',
          HttpStatus.CONFLICT,
          'Le paiement est en cours d’initialisation',
        );
      }
      await this.prisma.payment.updateMany({
        where: { id: open.id, status: 'INITIATED' },
        data: { status: 'FAILED', failureReason: 'Initialisation abandonnée' },
      });
    }

    // Prolonge le verrou pendant le règlement (au plus 3 fois sa durée de base : pas d'accaparement illimité).
    const holdMinutes = await this.settings.getInt(
      'booking.hold_minutes',
      this.env.BOOKING_HOLD_MINUTES,
    );
    const newHold = new Date(
      Math.min(
        now.getTime() + holdMinutes * 60_000,
        booking.createdAt.getTime() + holdMinutes * MAX_HOLD_MULTIPLE * 60_000,
      ),
    );

    let payment: Payment;
    try {
      payment = await this.prisma.$transaction(async (tx) => {
        if (booking.holdExpiresAt && newHold > booking.holdExpiresAt) {
          await tx.booking.updateMany({
            where: { id: bookingId, status: 'PENDING_PAYMENT' },
            data: { holdExpiresAt: newHold },
          });
        }
        return tx.payment.create({
          data: {
            bookingId,
            provider: this.provider.id,
            kind: booking.paymentMode === 'FULL_ONLINE' ? 'FULL' : 'DEPOSIT',
            amountMinor: booking.dueOnlineMinor,
            currency: booking.currency,
            status: 'INITIATED',
            idempotencyKey: `${bookingId}:${idempotencyKey}`,
          },
        });
      });
    } catch (error) {
      if (!isPgError(error, PG_ERROR.UNIQUE_VIOLATION)) throw error;
      // Course : une autre requête vient d'ouvrir le paiement (ou la même clé a déjà servi). On rend le sien.
      const existing =
        (await this.prisma.payment.findUnique({
          where: { idempotencyKey: `${bookingId}:${idempotencyKey}` },
        })) ?? (await this.openPayment(bookingId));
      if (existing?.status === 'PENDING' && existing.checkoutUrl) return toPaymentView(existing);
      throw new AppException(
        'REQUEST_IN_PROGRESS',
        HttpStatus.CONFLICT,
        'Le paiement est en cours d’initialisation',
      );
    }

    try {
      const intent = await this.provider.createIntent({
        paymentId: payment.id,
        bookingReference: booking.reference,
        amountMinor: payment.amountMinor,
        currency: 'DZD',
        description: `Réservation ${booking.reference} — ${booking.venue.name}`,
        customer: { email: booking.customer.email, phone: booking.customer.phone },
        returnUrl: `${this.env.WEB_ORIGIN}/bookings/${booking.id}/payment?paymentId=${payment.id}`,
        cancelUrl: `${this.env.WEB_ORIGIN}/bookings/${booking.id}`,
      });
      const pending = await this.prisma.payment.update({
        where: { id: payment.id },
        data: {
          status: 'PENDING',
          providerRef: intent.providerRef,
          checkoutUrl: intent.checkoutUrl,
        },
      });
      return toPaymentView(pending);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Création du paiement impossible chez le prestataire : ${message}`);
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: { status: 'FAILED', failureReason: message.slice(0, 300) },
      });
      throw new AppException(
        'PAYMENT_PROVIDER_ERROR',
        HttpStatus.BAD_GATEWAY,
        'Le service de paiement est momentanément indisponible, réessayez dans un instant',
      );
    }
  }

  /**
   * Statut d'un de MES paiements. S'il est encore en cours, le serveur interroge LUI-MÊME le prestataire :
   * c'est ce que fait la page de retour — jamais « le navigateur dit que c'est payé ».
   */
  async getForUser(user: AuthUser, paymentId: string): Promise<PaymentView> {
    const payment = await this.prisma.payment.findFirst({
      where: { id: paymentId, booking: { userId: user.id } },
    });
    if (!payment) throw Errors.notFound('Paiement introuvable');

    if ((payment.status === 'INITIATED' || payment.status === 'PENDING') && payment.providerRef) {
      await this.sync(payment.id);
      return toPaymentView(
        await this.prisma.payment.findUniqueOrThrow({ where: { id: paymentId } }),
      );
    }
    return toPaymentView(payment);
  }

  // ───────────────────────── Confirmation côté serveur ─────────────────────────

  /** Interroge le prestataire sur l'état réel d'un paiement et l'applique. Sans effet si le prestataire est injoignable. */
  async sync(paymentId: string): Promise<ApplyOutcome | 'UNREACHABLE'> {
    const payment = await this.prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment?.providerRef) return 'IGNORED';
    let state: ProviderPaymentState;
    try {
      state = await this.provider.getPaymentState(payment.providerRef);
    } catch (error) {
      this.logger.warn(
        `Prestataire injoignable pour le paiement ${paymentId} : ${error instanceof Error ? error.message : error}`,
      );
      return 'UNREACHABLE';
    }
    return this.applyState(payment, state);
  }

  /** Applique un état CONFIRMÉ par le prestataire. Idempotent : rejouer le même état ne change plus rien. */
  async applyState(payment: Payment, state: ProviderPaymentState): Promise<ApplyOutcome> {
    if (state.providerRef !== payment.providerRef) return 'IGNORED';

    switch (state.status) {
      case 'PENDING':
        return 'IGNORED';
      case 'FAILED': {
        const done = await this.prisma.payment.updateMany({
          where: { id: payment.id, status: { in: [...OPEN_STATUSES] } },
          data: {
            status: 'FAILED',
            failureReason: (state.failureReason ?? 'Paiement refusé').slice(0, 300),
          },
        });
        return done.count > 0 ? 'APPLIED' : 'IGNORED';
      }
      case 'CANCELLED': {
        const done = await this.prisma.payment.updateMany({
          where: { id: payment.id, status: { in: [...OPEN_STATUSES] } },
          data: { status: 'CANCELLED' },
        });
        return done.count > 0 ? 'APPLIED' : 'IGNORED';
      }
      case 'SUCCEEDED':
        return this.applySucceeded(payment, state);
    }
  }

  private async applySucceeded(
    payment: Payment,
    state: ProviderPaymentState,
  ): Promise<ApplyOutcome> {
    // Le montant RÉELLEMENT encaissé doit être exactement celui attendu. Sinon on ne confirme rien et on alerte.
    if (state.amountMinor !== payment.amountMinor || state.currency !== payment.currency) {
      await this.flagMismatch(payment, state);
      return 'MISMATCH';
    }

    // Revendication atomique : une seule requête (webhook, page de retour, maintenance…) fait la transition.
    // La vérité du prestataire l'emporte, y compris sur un paiement local « annulé » ou « échoué » (argent reçu).
    const claimed = await this.prisma.payment.updateMany({
      where: { id: payment.id, status: { in: ['INITIATED', 'PENDING', 'FAILED', 'CANCELLED'] } },
      data: { status: 'SUCCEEDED', paidAt: state.paidAt ?? new Date(), failureReason: null },
    });
    if (claimed.count === 0) return 'IGNORED'; // déjà traité : livraison en double

    await this.settleBooking(payment.id);
    return 'APPLIED';
  }

  /**
   * Un paiement réussi doit aboutir à une réservation confirmée — ou à un remboursement automatique.
   * Idempotent : peut être rejoué par la maintenance si un plantage a interrompu le traitement.
   */
  async settleBooking(paymentId: string, depth = 0): Promise<void> {
    const payment = await this.prisma.payment.findUniqueOrThrow({
      where: { id: paymentId },
      include: { booking: true },
    });
    if (payment.status !== 'SUCCEEDED') return;
    const { booking } = payment;

    // Paiement en double : une autre tentative a DÉJÀ réglé la réservation avant celle-ci → celle-ci est remboursée.
    // « Avant » = date de RÈGLEMENT (pas de création : un ancien paiement abandonné puis réglé tardivement, après
    // le nouveau, est bien le doublon). L'identifiant départage deux règlements simultanés, de façon déterministe :
    // deux paiements ne peuvent donc jamais se rembourser mutuellement.
    const paidOthers = await this.prisma.payment.findMany({
      where: {
        bookingId: booking.id,
        id: { not: payment.id },
        status: { in: ['SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUNDED'] },
      },
      select: { id: true, paidAt: true, amountMinor: true },
    });
    const myPaidAt = (payment.paidAt ?? payment.createdAt).getTime();
    const earlier = paidOthers.filter((p) => {
      const theirs = (p.paidAt ?? new Date(0)).getTime();
      return theirs < myPaidAt || (theirs === myPaidAt && p.id < payment.id);
    });
    if (earlier.reduce((sum, p) => sum + p.amountMinor, 0) >= booking.dueOnlineMinor) {
      await this.autoRefund(payment, 'Paiement en double : la réservation est déjà réglée');
      return;
    }

    switch (booking.status) {
      case 'CONFIRMED':
      case 'COMPLETED':
      case 'NO_SHOW':
        return; // déjà confirmée (livraison en double, ou reprise après plantage)
      case 'PENDING_PAYMENT': {
        const confirmed = await this.prisma.booking.updateMany({
          where: { id: booking.id, status: 'PENDING_PAYMENT' },
          data: { status: 'CONFIRMED', holdExpiresAt: null },
        });
        if (confirmed.count === 1) {
          await this.events.emit('booking.confirmed', { bookingId: booking.id });
        } else if (depth < 3) {
          await this.settleBooking(paymentId, depth + 1); // l'état a changé entre-temps : on réévalue
        }
        return;
      }
      case 'EXPIRED': {
        // Paiement arrivé après l'expiration du verrou. Si le créneau est encore libre, on le rend au client ;
        // s'il a été repris, la contrainte d'exclusion refuse et on rembourse.
        try {
          const revived = await this.prisma.booking.updateMany({
            where: { id: booking.id, status: 'EXPIRED' },
            data: { status: 'CONFIRMED', holdExpiresAt: null },
          });
          if (revived.count === 1) {
            await this.events.emit('booking.confirmed', { bookingId: booking.id });
          } else if (depth < 3) {
            await this.settleBooking(paymentId, depth + 1);
          }
        } catch (error) {
          if (!isPgError(error, PG_ERROR.EXCLUSION_VIOLATION)) throw error;
          await this.autoRefund(
            payment,
            'Le créneau a été pris par un autre client pendant le paiement',
          );
        }
        return;
      }
      default:
        await this.autoRefund(
          payment,
          'La réservation avait été annulée avant la confirmation du paiement',
        );
    }
  }

  private async flagMismatch(payment: Payment, state: ProviderPaymentState): Promise<void> {
    this.logger.error(
      `ANOMALIE paiement ${payment.id} : attendu ${payment.amountMinor} ${payment.currency}, reçu ${state.amountMinor} ${state.currency}`,
    );
    await this.audit.record({
      actorRole: 'SYSTEM',
      action: 'payment.amount_mismatch',
      entityType: 'Payment',
      entityId: payment.id,
      before: { amountMinor: payment.amountMinor, currency: payment.currency },
      after: { amountMinor: state.amountMinor, currency: state.currency },
    });
  }

  // ───────────────────────── Annulation côté prestataire ─────────────────────────

  /** Une réservation annulée ou expirée ne doit plus pouvoir être payée : on ferme le paiement chez le prestataire. */
  async cancelPendingForBooking(bookingId: string): Promise<void> {
    const open = await this.prisma.payment.findMany({
      where: { bookingId, status: { in: [...OPEN_STATUSES] } },
    });
    for (const payment of open) {
      if (!payment.providerRef) {
        await this.prisma.payment.updateMany({
          where: { id: payment.id, status: 'INITIATED' },
          data: { status: 'CANCELLED' },
        });
        continue;
      }
      try {
        await this.provider.cancelIntent(payment.providerRef);
        await this.prisma.payment.updateMany({
          where: { id: payment.id, status: { in: [...OPEN_STATUSES] } },
          data: { status: 'CANCELLED' },
        });
      } catch (error) {
        // Le prestataire refuse (souvent : déjà réglé) ou est injoignable : on s'en remet à son état réel.
        // S'il est réglé, `settleBooking` verra une réservation annulée et remboursera automatiquement.
        this.logger.warn(
          `Annulation du paiement ${payment.id} chez le prestataire impossible : ${error instanceof Error ? error.message : error}`,
        );
        await this.sync(payment.id);
      }
    }
  }

  // ───────────────────────── Remboursements ─────────────────────────

  /** Demande et exécute le remboursement intégral d'un paiement (cas automatiques : doublon, annulation avant confirmation). */
  private async autoRefund(payment: Payment, reason: string): Promise<void> {
    const requested = await this.prisma.$transaction((tx) =>
      this.refunds.requestForPayment(tx, {
        paymentId: payment.id,
        bookingId: payment.bookingId,
        reason,
        requestedById: null,
      }),
    );
    await this.audit.record({
      actorRole: 'SYSTEM',
      action: 'payment.auto_refund',
      entityType: 'Payment',
      entityId: payment.id,
      after: { reason, refundMinor: requested.totalMinor },
    });
    for (const refundId of requested.refundIds) await this.processRefund(refundId);
  }

  /**
   * Exécute un remboursement auprès du prestataire. Idempotent à tous les niveaux :
   *  - le passage REQUESTED → PROCESSING est atomique (un seul exécutant) ;
   *  - l'identifiant du remboursement sert de clé d'idempotence chez le prestataire (jamais deux remboursements) ;
   *  - `retryStuck` reprend un remboursement resté « en cours » après un plantage.
   */
  async processRefund(refundId: string, options: { retryStuck?: boolean } = {}): Promise<void> {
    const claimed = await this.prisma.refund.updateMany({
      where: {
        id: refundId,
        status: { in: options.retryStuck ? ['REQUESTED', 'PROCESSING'] : ['REQUESTED'] },
      },
      data: { status: 'PROCESSING' },
    });
    if (claimed.count === 0) return;

    const refund = await this.prisma.refund.findUniqueOrThrow({
      where: { id: refundId },
      include: { payment: true },
    });
    if (!refund.payment.providerRef) {
      await this.failRefund(refund.id, 'Paiement sans référence chez le prestataire');
      return;
    }

    try {
      const outcome = await this.provider.refund({
        providerRef: refund.payment.providerRef,
        amountMinor: refund.amountMinor,
        refundId: refund.id,
        reason: refund.reason ?? undefined,
      });

      if (outcome.status === 'SUCCEEDED') {
        await this.prisma.$transaction(async (tx) => {
          await tx.refund.update({
            where: { id: refund.id },
            data: {
              status: 'SUCCEEDED',
              providerRef: outcome.providerRef,
              processedAt: new Date(),
            },
          });
          const refunded = await tx.refund.aggregate({
            _sum: { amountMinor: true },
            where: { paymentId: refund.paymentId, status: 'SUCCEEDED' },
          });
          const total = refunded._sum.amountMinor ?? 0;
          await tx.payment.update({
            where: { id: refund.paymentId },
            data: {
              status: total >= refund.payment.amountMinor ? 'REFUNDED' : 'PARTIALLY_REFUNDED',
            },
          });
          await this.audit.record(
            {
              actorRole: 'SYSTEM',
              action: 'refund.succeeded',
              entityType: 'Refund',
              entityId: refund.id,
              after: { amountMinor: refund.amountMinor, paymentId: refund.paymentId },
            },
            undefined,
            tx,
          );
        });
      } else if (outcome.status === 'PENDING') {
        await this.prisma.refund.update({
          where: { id: refund.id },
          data: { providerRef: outcome.providerRef },
        }); // confirmé plus tard
      } else {
        await this.failRefund(refund.id, outcome.failureReason ?? 'Refusé par le prestataire');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof PaymentProviderError && !error.retryable) {
        await this.failRefund(refund.id, message);
      } else {
        // Panne temporaire : on remet la demande en file, la maintenance réessaiera.
        this.logger.warn(`Remboursement ${refund.id} reporté : ${message}`);
        await this.prisma.refund.updateMany({
          where: { id: refund.id, status: 'PROCESSING' },
          data: { status: 'REQUESTED' },
        });
      }
    }
  }

  private async failRefund(refundId: string, reason: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const current = await tx.refund.findUniqueOrThrow({
        where: { id: refundId },
        select: { reason: true },
      });
      await tx.refund.update({
        where: { id: refundId },
        // On garde le motif d'origine et on y ajoute la cause de l'échec.
        data: {
          status: 'FAILED',
          reason: `${current.reason ?? ''} | ÉCHEC : ${reason}`.slice(0, 500),
          processedAt: new Date(),
        },
      });
      await this.audit.record(
        {
          actorRole: 'SYSTEM',
          action: 'refund.failed',
          entityType: 'Refund',
          entityId: refundId,
          after: { reason },
        },
        undefined,
        tx,
      );
    });
    this.logger.error(
      `Remboursement ${refundId} en échec : ${reason} — intervention manuelle requise`,
    );
  }

  // ───────────────────────── Aides ─────────────────────────

  private openPayment(bookingId: string): Promise<Payment | null> {
    return this.prisma.payment.findFirst({
      where: { bookingId, status: { in: [...OPEN_STATUSES] } },
      orderBy: { createdAt: 'desc' },
    });
  }
}
