import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ENV } from '../../infra/config/config.module.js';
import type { Env } from '../../infra/config/env.js';
import { PrismaService } from '../../infra/database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { PaymentsService } from './payments.service.js';

const INTERVAL_MS = 30_000;
const BATCH = 50;
const MINUTE = 60_000;

export interface PaymentsMaintenanceResult {
  staleInitiated: number;
  closedForDeadBookings: number;
  synced: number;
  resettled: number;
  refundsProcessed: number;
  refundsAbandoned: number;
}

/**
 * Filet de sécurité des paiements, toutes les 30 s. Il rattrape ce qu'un webhook perdu, un plantage ou une panne
 * du prestataire ont pu laisser en route — pour qu'aucun paiement ne reste bloqué dans un état intermédiaire.
 *
 * Toutes les opérations sont IDEMPOTENTES (transitions conditionnelles, clés d'idempotence chez le prestataire) :
 * plusieurs instances de l'API peuvent l'exécuter en même temps sans risque, d'où l'absence de verrou global.
 */
@Injectable()
export class PaymentsMaintenanceService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PaymentsMaintenanceService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: PaymentsService,
    private readonly audit: AuditService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  onModuleInit(): void {
    if (this.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => {
      this.runOnce().catch((error: unknown) =>
        this.logger.error(
          'Échec de la maintenance des paiements',
          error instanceof Error ? error.stack : String(error),
        ),
      );
    }, INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async runOnce(now: Date = new Date()): Promise<PaymentsMaintenanceResult> {
    const result: PaymentsMaintenanceResult = {
      staleInitiated: 0,
      closedForDeadBookings: 0,
      synced: 0,
      resettled: 0,
      refundsProcessed: 0,
      refundsAbandoned: 0,
    };

    // 1. Initialisation abandonnée (plantage entre la création et l'appel au prestataire).
    result.staleInitiated = (
      await this.prisma.payment.updateMany({
        where: { status: 'INITIATED', createdAt: { lt: new Date(now.getTime() - 5 * MINUTE) } },
        data: { status: 'FAILED', failureReason: 'Initialisation abandonnée' },
      })
    ).count;

    // 2. Paiements encore ouverts alors que la réservation est annulée ou expirée : on les ferme chez le prestataire.
    const dead = await this.prisma.payment.findMany({
      where: {
        status: { in: ['INITIATED', 'PENDING'] },
        booking: { status: { in: ['CANCELLED', 'EXPIRED'] } },
      },
      select: { bookingId: true },
      distinct: ['bookingId'],
      take: BATCH,
    });
    for (const { bookingId } of dead) {
      await this.payments.cancelPendingForBooking(bookingId);
      result.closedForDeadBookings += 1;
    }

    // 3. Paiements en attente depuis plus d'une minute : le webhook s'est peut-être perdu → on demande au prestataire.
    const pending = await this.prisma.payment.findMany({
      where: {
        status: 'PENDING',
        createdAt: {
          lt: new Date(now.getTime() - MINUTE),
          gt: new Date(now.getTime() - 48 * 60 * MINUTE),
        },
      },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
      take: BATCH,
    });
    for (const { id } of pending) {
      if ((await this.payments.sync(id)) === 'APPLIED') result.synced += 1;
    }

    // 4. Paiement réussi mais réservation encore « en attente » : le traitement a été interrompu → on le termine.
    const unsettled = await this.prisma.payment.findMany({
      where: { status: 'SUCCEEDED', booking: { status: 'PENDING_PAYMENT' } },
      select: { id: true },
      take: BATCH,
    });
    for (const { id } of unsettled) {
      await this.payments.settleBooking(id);
      result.resettled += 1;
    }

    // 5. Remboursements : demandes en attente, traitements restés « en cours », et abandon après 24 h d'échecs.
    const abandoned = await this.prisma.refund.findMany({
      where: { status: 'REQUESTED', createdAt: { lt: new Date(now.getTime() - 24 * 60 * MINUTE) } },
      select: { id: true },
      take: BATCH,
    });
    for (const { id } of abandoned) {
      await this.prisma.refund.update({
        where: { id },
        data: {
          status: 'FAILED',
          reason: 'Abandon après 24 h de tentatives : intervention manuelle requise',
        },
      });
      await this.audit.record({
        actorRole: 'SYSTEM',
        action: 'refund.abandoned',
        entityType: 'Refund',
        entityId: id,
      });
      this.logger.error(`Remboursement ${id} abandonné après 24 h : intervention manuelle requise`);
      result.refundsAbandoned += 1;
    }

    const todo = await this.prisma.refund.findMany({
      where: {
        OR: [
          { status: 'REQUESTED' },
          { status: 'PROCESSING', createdAt: { lt: new Date(now.getTime() - 10 * MINUTE) } },
        ],
      },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
      take: BATCH,
    });
    for (const { id } of todo) {
      await this.payments.processRefund(id, { retryStuck: true });
      result.refundsProcessed += 1;
    }

    return result;
  }
}
