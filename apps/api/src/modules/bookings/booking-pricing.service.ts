import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { type CancellationPolicy, type DepositPolicy, depositPolicySchema } from '@footfive/shared';
import type { BookingType, Prisma } from '../../generated/prisma/client.js';
import { AppException } from '../../common/errors/app-exception.js';
import { PrismaService } from '../../infra/database/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { FALLBACK_CANCELLATION_POLICY, parseCancellationPolicy } from './cancellation.js';
import {
  type AmountsPaymentMode,
  type BookingAmounts,
  type CommissionTerms,
  computeBookingAmounts,
} from './money.js';

/** Dernier recours si ni le complexe ni la plateforme n'ont d'acompte valide : 20 % du total. */
export const FALLBACK_DEPOSIT_POLICY: DepositPolicy = {
  mode: 'PERCENT',
  rateBps: 2000,
  fixedMinor: 0,
  minMinor: 0,
};

export interface PricedBooking {
  amounts: BookingAmounts;
  /** Règle de commission appliquée (traçabilité) ; null si aucune règle active. */
  commissionRuleId: string | null;
}

const SCOPE_PRIORITY = { VENUE: 3, BOOKING_TYPE: 2, GLOBAL: 1 } as const;

/**
 * Détermine la commission et l'acompte applicables à une réservation, puis calcule tous les montants.
 * 100 % SERVEUR : rien de ce que le client envoie n'influence un montant.
 */
@Injectable()
export class BookingPricingService {
  private readonly logger = new Logger(BookingPricingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  /**
   * Règle de commission : la plus SPÉCIFIQUE l'emporte (complexe > type de réservation > globale),
   * parmi les règles actives et valides à cet instant.
   */
  async resolveCommission(
    venueId: string,
    bookingType: BookingType,
    now: Date,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<{ ruleId: string; terms: CommissionTerms }> {
    const rules = await db.commissionRule.findMany({
      where: {
        isActive: true,
        validFrom: { lte: now },
        OR: [{ validTo: null }, { validTo: { gt: now } }],
        AND: [
          {
            OR: [
              { scope: 'GLOBAL' },
              { scope: 'VENUE', venueId },
              { scope: 'BOOKING_TYPE', bookingType },
            ],
          },
        ],
      },
    });

    const best = rules.sort((a, b) => SCOPE_PRIORITY[b.scope] - SCOPE_PRIORITY[a.scope])[0];
    if (!best) {
      // Mieux vaut refuser de vendre que vendre sans commission en silence : l'admin doit corriger la configuration.
      this.logger.error(
        'Aucune règle de commission active : réservations impossibles tant que ce n’est pas corrigé.',
      );
      throw new AppException(
        'INTERNAL_ERROR',
        HttpStatus.SERVICE_UNAVAILABLE,
        'Les réservations sont momentanément indisponibles',
      );
    }
    return { ruleId: best.id, terms: { rateBps: best.rateBps, fixedMinor: best.fixedMinor } };
  }

  /** Acompte : politique du complexe, sinon celle de la plateforme, sinon valeur de secours. */
  async resolveDepositPolicy(venueDepositPolicy: unknown): Promise<DepositPolicy> {
    for (const candidate of [
      venueDepositPolicy,
      await this.settings.getJson('booking.default_deposit'),
    ]) {
      const parsed = depositPolicySchema.safeParse(candidate);
      if (parsed.success) return parsed.data;
    }
    return FALLBACK_DEPOSIT_POLICY;
  }

  /** Politique d'annulation : celle du complexe, sinon celle de la plateforme, sinon la valeur de secours. */
  async resolveCancellationPolicy(venuePolicy: unknown): Promise<CancellationPolicy> {
    return (
      parseCancellationPolicy(venuePolicy) ??
      parseCancellationPolicy(await this.settings.getJson('booking.default_cancellation_policy')) ??
      FALLBACK_CANCELLATION_POLICY
    );
  }

  async price(args: {
    venue: { id: string; depositPolicy: unknown };
    basePriceMinor: number;
    paymentMode: AmountsPaymentMode;
    bookingType: BookingType;
    now: Date;
    db?: Prisma.TransactionClient;
  }): Promise<PricedBooking> {
    const { ruleId, terms } = await this.resolveCommission(
      args.venue.id,
      args.bookingType,
      args.now,
      args.db,
    );
    const deposit = await this.resolveDepositPolicy(args.venue.depositPolicy);
    return {
      commissionRuleId: ruleId,
      amounts: computeBookingAmounts({
        basePriceMinor: args.basePriceMinor,
        commission: terms,
        paymentMode: args.paymentMode,
        deposit,
      }),
    };
  }
}
