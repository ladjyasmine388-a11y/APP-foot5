import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import { AppException, Errors } from '../../common/errors/app-exception.js';
import { PG_ERROR, isPgError } from '../../infra/database/pg-errors.js';
import { PrismaService } from '../../infra/database/prisma.service.js';
import { PaymentsService } from './payments.service.js';
import { InvalidWebhookSignatureError, PaymentProvider } from './providers/payment-provider.js';

export type WebhookResult = 'processed' | 'duplicate' | 'ignored' | 'rejected';

/**
 * Réception des webhooks du prestataire de paiement.
 *
 *  1. SIGNATURE : le corps brut est authentifié (HMAC + horodatage) avant tout. Sinon 401, rien n'est enregistré.
 *  2. DOUBLONS : un prestataire renvoie le même événement plusieurs fois. (prestataire, eventId) est unique en base :
 *     une livraison déjà traitée est acquittée sans rien refaire.
 *  3. VÉRITÉ : le contenu du webhook n'est PAS cru. Il désigne un paiement ; l'état réel est demandé au prestataire
 *     (appel serveur à serveur) puis appliqué. Un webhook mensonger — même correctement signé — ne peut rien confirmer.
 *  4. ERREUR TEMPORAIRE : on répond 500 pour que le prestataire réessaie ; l'événement reste « FAILED » et rejouable.
 */
@Injectable()
export class PaymentWebhooksService {
  private readonly logger = new Logger(PaymentWebhooksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: PaymentsService,
    private readonly provider: PaymentProvider,
  ) {}

  async handle(
    providerId: string,
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<WebhookResult> {
    if (providerId !== this.provider.id) throw Errors.notFound('Prestataire inconnu');

    let event;
    try {
      event = this.provider.parseWebhook(rawBody, headers);
    } catch (error) {
      if (error instanceof InvalidWebhookSignatureError) {
        this.logger.warn(`Webhook rejeté : ${error.message}`);
        throw new AppException(
          'INVALID_WEBHOOK_SIGNATURE',
          HttpStatus.UNAUTHORIZED,
          'Signature invalide',
        );
      }
      throw error;
    }

    // Enregistrement idempotent de l'événement
    let eventRowId: string;
    try {
      const created = await this.prisma.webhookEvent.create({
        data: {
          provider: providerId,
          eventId: event.eventId,
          type: event.type,
          payload: event.payload as Prisma.InputJsonValue,
          status: 'RECEIVED',
        },
      });
      eventRowId = created.id;
    } catch (error) {
      if (!isPgError(error, PG_ERROR.UNIQUE_VIOLATION)) throw error;
      const existing = await this.prisma.webhookEvent.findUniqueOrThrow({
        where: { provider_eventId: { provider: providerId, eventId: event.eventId } },
      });
      if (existing.status === 'PROCESSED' || existing.status === 'IGNORED') return 'duplicate';
      eventRowId = existing.id; // RECEIVED ou FAILED : on retraite (les traitements sont idempotents)
    }

    try {
      // Les événements autres que de paiement (remboursements…) sont acquittés sans effet pour l'instant.
      if (!event.type.startsWith('payment.')) {
        await this.finish(eventRowId, 'IGNORED', `Type d'événement non géré : ${event.type}`);
        return 'ignored';
      }

      const payment = await this.prisma.payment.findFirst({
        where: { provider: providerId, providerRef: event.providerRef },
      });
      if (!payment) {
        await this.finish(eventRowId, 'IGNORED', 'Paiement inconnu');
        return 'ignored';
      }

      // La VÉRITÉ vient du prestataire, pas du contenu du webhook.
      const state = await this.provider.getPaymentState(event.providerRef);
      const outcome = await this.payments.applyState(payment, state);

      if (outcome === 'MISMATCH') {
        // Définitif : inutile que le prestataire réessaie. Alerte déjà émise (journal + audit).
        await this.finish(eventRowId, 'FAILED', 'Montant encaissé différent du montant attendu');
        return 'rejected';
      }
      await this.finish(eventRowId, 'PROCESSED');
      return 'processed';
    } catch (error) {
      await this.finish(
        eventRowId,
        'FAILED',
        error instanceof Error ? error.message : String(error),
      ).catch(() => undefined);
      throw error; // 500 : le prestataire réessaiera
    }
  }

  private finish(id: string, status: 'PROCESSED' | 'IGNORED' | 'FAILED', error?: string) {
    return this.prisma.webhookEvent.update({
      where: { id },
      data: { status, error: error?.slice(0, 500) ?? null, processedAt: new Date() },
    });
  }
}
