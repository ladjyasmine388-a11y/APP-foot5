import { createHmac, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ENV } from '../../../infra/config/config.module.js';
import type { Env } from '../../../infra/config/env.js';
import { safeEqual } from '../../../infra/security/crypto.js';
import {
  type CreateIntentInput,
  type CreatedIntent,
  InvalidWebhookSignatureError,
  PaymentProvider,
  PaymentProviderError,
  type ProviderPaymentState,
  type ProviderPaymentStatus,
  type RefundOutcome,
  type RefundRequest,
  type WebhookEvent,
} from './payment-provider.js';

/** Tolérance sur l'horodatage de la signature : au-delà, un webhook intercepté ne peut plus être rejoué. */
const SIGNATURE_TOLERANCE_MS = 5 * 60 * 1000;
const SIGNATURE_HEADER = 'x-fake-signature';

interface FakePayment {
  providerRef: string;
  paymentId: string;
  bookingReference: string;
  description: string;
  amountMinor: number;
  currency: string;
  status: ProviderPaymentStatus;
  returnUrl: string;
  cancelUrl: string;
  paidAt: Date | null;
  failureReason: string | null;
  refundedMinor: number;
}

export interface SignedWebhook {
  rawBody: Buffer;
  headers: Record<string, string>;
}

/**
 * PRESTATAIRE SIMULÉ — développement et tests UNIQUEMENT (refusé au démarrage en production, voir env.ts).
 *
 * Il joue le rôle d'un vrai prestataire de façon fidèle, pour que le code applicatif soit exercé exactement comme
 * avec CIB / Edahabia : état de paiement qui vit CHEZ le prestataire, page de paiement hébergée, webhook signé
 * (HMAC-SHA256 + horodatage), remboursements idempotents. Ses états sont en mémoire (un seul processus).
 *
 * Les méthodes « simulate… » et « force… » ne font pas partie du contrat `PaymentProvider` : ce sont les
 * commandes de la page de paiement de démonstration et des tests.
 */
@Injectable()
export class FakePaymentProvider extends PaymentProvider {
  readonly id = 'fake';

  private readonly payments = new Map<string, FakePayment>();
  private readonly refunds = new Map<string, RefundOutcome & { amountMinor: number }>();
  private readonly secret: string;
  private readonly apiUrl: string;

  /** Panne simulée : la prochaine création de paiement / le prochain remboursement échoue. */
  failNextIntent = false;
  failNextRefund = false;

  constructor(@Inject(ENV) env: Env) {
    super();
    this.secret = env.PAYMENT_WEBHOOK_SECRET;
    this.apiUrl = (env.API_PUBLIC_URL ?? `http://localhost:${env.API_PORT}`).replace(/\/$/, '');
  }

  // ───────────────────────── Contrat PaymentProvider ─────────────────────────

  async createIntent(input: CreateIntentInput): Promise<CreatedIntent> {
    if (this.failNextIntent) {
      this.failNextIntent = false;
      return Promise.reject(new PaymentProviderError('Prestataire simulé indisponible'));
    }
    // Idempotence : la même demande (même paiement) rend le même paiement chez le prestataire.
    const existing = [...this.payments.values()].find((p) => p.paymentId === input.paymentId);
    if (existing) return Promise.resolve(this.intentFor(existing));

    const payment: FakePayment = {
      providerRef: `fake_pay_${randomBytes(12).toString('hex')}`,
      paymentId: input.paymentId,
      bookingReference: input.bookingReference,
      description: input.description,
      amountMinor: input.amountMinor,
      currency: input.currency,
      status: 'PENDING',
      returnUrl: input.returnUrl,
      cancelUrl: input.cancelUrl,
      paidAt: null,
      failureReason: null,
      refundedMinor: 0,
    };
    this.payments.set(payment.providerRef, payment);
    return Promise.resolve(this.intentFor(payment));
  }

  async getPaymentState(providerRef: string): Promise<ProviderPaymentState> {
    const p = this.require(providerRef);
    return Promise.resolve({
      providerRef,
      status: p.status,
      amountMinor: p.amountMinor,
      currency: p.currency,
      paidAt: p.paidAt,
      failureReason: p.failureReason,
    });
  }

  async cancelIntent(providerRef: string): Promise<void> {
    const p = this.require(providerRef);
    if (p.status === 'SUCCEEDED') {
      return Promise.reject(
        new PaymentProviderError('Un paiement abouti ne peut pas être annulé', false),
      );
    }
    if (p.status === 'PENDING') p.status = 'CANCELLED';
    return Promise.resolve();
  }

  async refund(request: RefundRequest): Promise<RefundOutcome> {
    // Idempotence : un remboursement déjà traité renvoie le même résultat, sans rembourser une seconde fois.
    const known = this.refunds.get(request.refundId);
    if (known)
      return Promise.resolve({
        providerRef: known.providerRef,
        status: known.status,
        failureReason: known.failureReason,
      });

    const p = this.require(request.providerRef);
    const refundRef = `fake_ref_${randomBytes(10).toString('hex')}`;
    let outcome: RefundOutcome;
    if (this.failNextRefund) {
      this.failNextRefund = false;
      outcome = {
        providerRef: refundRef,
        status: 'FAILED',
        failureReason: 'Échec simulé du remboursement',
      };
    } else if (p.status !== 'SUCCEEDED') {
      outcome = {
        providerRef: refundRef,
        status: 'FAILED',
        failureReason: 'Paiement non abouti : rien à rembourser',
      };
    } else if (request.amountMinor > p.amountMinor - p.refundedMinor) {
      outcome = {
        providerRef: refundRef,
        status: 'FAILED',
        failureReason: 'Montant supérieur au solde remboursable',
      };
    } else {
      p.refundedMinor += request.amountMinor;
      outcome = { providerRef: refundRef, status: 'SUCCEEDED' };
    }
    this.refunds.set(request.refundId, { ...outcome, amountMinor: request.amountMinor });
    return Promise.resolve(outcome);
  }

  parseWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): WebhookEvent {
    const header = headers[SIGNATURE_HEADER];
    const value = Array.isArray(header) ? header[0] : header;
    if (!value) throw new InvalidWebhookSignatureError('en-tête de signature absent');

    const parts = Object.fromEntries(
      value.split(',').map((kv) => kv.split('=', 2) as [string, string]),
    );
    const timestamp = Number(parts['t']);
    const signature = parts['v1'];
    if (!Number.isFinite(timestamp) || !signature)
      throw new InvalidWebhookSignatureError('format incorrect');
    if (Math.abs(Date.now() - timestamp * 1000) > SIGNATURE_TOLERANCE_MS) {
      throw new InvalidWebhookSignatureError('horodatage hors tolérance (rejeu ?)');
    }
    if (!safeEqual(signature, this.sign(timestamp, rawBody)))
      throw new InvalidWebhookSignatureError('signature incorrecte');

    let body: { id?: unknown; type?: unknown; providerRef?: unknown };
    try {
      body = JSON.parse(rawBody.toString('utf8')) as typeof body;
    } catch {
      throw new InvalidWebhookSignatureError('corps illisible');
    }
    if (
      typeof body.id !== 'string' ||
      typeof body.type !== 'string' ||
      typeof body.providerRef !== 'string'
    ) {
      throw new InvalidWebhookSignatureError('événement incomplet');
    }
    return { eventId: body.id, type: body.type, providerRef: body.providerRef, payload: body };
  }

  // ───────────────────── Commandes de démonstration et de test ─────────────────────

  /** Le payeur règle (ou échoue / abandonne) sur la page du prestataire. Retourne le webhook SIGNÉ que le prestataire enverrait. */
  completePayment(
    providerRef: string,
    outcome: Exclude<ProviderPaymentStatus, 'PENDING'>,
  ): SignedWebhook {
    const p = this.require(providerRef);
    if (p.status !== 'PENDING') {
      throw new PaymentProviderError(`Ce paiement n'est plus en attente (${p.status})`, false);
    }
    p.status = outcome;
    if (outcome === 'SUCCEEDED') p.paidAt = new Date();
    if (outcome === 'FAILED') p.failureReason = 'Paiement refusé par la banque (simulation)';
    return this.buildWebhook(`payment.${outcome.toLowerCase()}`, providerRef);
  }

  /** Fabrique un webhook signé arbitraire (tests : rejeu, doublon, contenu falsifié…). */
  buildWebhook(
    type: string,
    providerRef: string,
    eventId: string = `evt_${randomBytes(10).toString('hex')}`,
    now = Date.now(),
  ): SignedWebhook {
    const rawBody = Buffer.from(JSON.stringify({ id: eventId, type, providerRef }));
    return { rawBody, headers: this.signatureHeaders(rawBody, now) };
  }

  signatureHeaders(rawBody: Buffer, now = Date.now()): Record<string, string> {
    const timestamp = Math.floor(now / 1000);
    return { [SIGNATURE_HEADER]: `t=${timestamp},v1=${this.sign(timestamp, rawBody)}` };
  }

  /** Données de la page de paiement de démonstration. */
  checkoutData(
    providerRef: string,
  ): Pick<
    FakePayment,
    | 'providerRef'
    | 'bookingReference'
    | 'description'
    | 'amountMinor'
    | 'currency'
    | 'status'
    | 'returnUrl'
    | 'cancelUrl'
  > | null {
    return this.payments.get(providerRef) ?? null;
  }

  /** Test : modifie l'état côté prestataire (ex. un montant différent de celui attendu). */
  forceState(
    providerRef: string,
    patch: Partial<Pick<FakePayment, 'status' | 'amountMinor' | 'currency'>>,
  ): void {
    Object.assign(this.require(providerRef), patch);
    if (patch.status === 'SUCCEEDED') this.require(providerRef).paidAt ??= new Date();
  }

  refundedMinor(providerRef: string): number {
    return this.require(providerRef).refundedMinor;
  }

  /** Test : remet le prestataire à zéro. */
  reset(): void {
    this.payments.clear();
    this.refunds.clear();
    this.failNextIntent = false;
    this.failNextRefund = false;
  }

  // ───────────────────────── Interne ─────────────────────────

  private intentFor(p: FakePayment): CreatedIntent {
    return {
      providerRef: p.providerRef,
      checkoutUrl: `${this.apiUrl}/api/v1/dev/fake-provider/checkout/${p.providerRef}`,
    };
  }

  private require(providerRef: string): FakePayment {
    const p = this.payments.get(providerRef);
    if (!p)
      throw new PaymentProviderError(
        `Paiement inconnu chez le prestataire : ${providerRef}`,
        false,
      );
    return p;
  }

  private sign(timestamp: number, rawBody: Buffer): string {
    return createHmac('sha256', this.secret).update(`${timestamp}.`).update(rawBody).digest('hex');
  }
}
