/**
 * Contrat que tout prestataire de paiement (CIB / Edahabia via SATIM ou un agrégateur local, ou le fournisseur
 * simulé) doit respecter. Le reste de l'application ne connaît QUE ce contrat : changer de prestataire, ou en
 * avoir plusieurs, revient à écrire un adaptateur — sans toucher aux réservations ni aux paiements.
 *
 * Principe de sécurité : un paiement n'est « réussi » que si le SERVEUR l'a confirmé auprès du prestataire
 * (`getPaymentState`, appel serveur à serveur). Ni la redirection du navigateur, ni le contenu brut d'un webhook
 * ne suffisent : le webhook sert de déclencheur, la confirmation vient d'une requête que NOUS émettons.
 */

export type ProviderPaymentStatus = 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';

export interface CreateIntentInput {
  /** Identifiant de notre `Payment` : sert de référence marchande et de clé d'idempotence côté prestataire. */
  paymentId: string;
  /** Référence lisible de la réservation (FF-XXXXXXXX), affichée au payeur. */
  bookingReference: string;
  amountMinor: number;
  currency: 'DZD';
  description: string;
  customer: { email: string; phone: string };
  /** Où le navigateur est renvoyé après le paiement. Information de CONFORT, jamais une preuve de paiement. */
  returnUrl: string;
  cancelUrl: string;
}

export interface CreatedIntent {
  /** Référence du paiement chez le prestataire (unique par prestataire). */
  providerRef: string;
  /** Page de paiement hébergée par le prestataire, vers laquelle on redirige le joueur. */
  checkoutUrl: string;
  raw?: unknown;
}

export interface ProviderPaymentState {
  providerRef: string;
  status: ProviderPaymentStatus;
  amountMinor: number;
  currency: string;
  paidAt: Date | null;
  failureReason: string | null;
}

export interface RefundRequest {
  /** Paiement d'origine chez le prestataire. */
  providerRef: string;
  amountMinor: number;
  /** Identifiant de notre `Refund` : rejouer la même demande ne rembourse jamais deux fois. */
  refundId: string;
  reason?: string;
}

export interface RefundOutcome {
  providerRef: string;
  /** PENDING : le prestataire traite le remboursement de façon asynchrone (confirmé plus tard). */
  status: 'SUCCEEDED' | 'PENDING' | 'FAILED';
  failureReason?: string;
}

/** Événement webhook authentifié et normalisé. */
export interface WebhookEvent {
  /** Identifiant unique de l'événement chez le prestataire : sert à ignorer les livraisons multiples. */
  eventId: string;
  type: string;
  providerRef: string;
  /** Contenu brut déjà décodé (conservé pour l'audit). */
  payload: unknown;
}

export abstract class PaymentProvider {
  /** Identifiant stable, utilisé dans l'URL du webhook et stocké dans `Payment.provider`. */
  abstract readonly id: string;

  abstract createIntent(input: CreateIntentInput): Promise<CreatedIntent>;

  /** SOURCE DE VÉRITÉ : interroge le prestataire (serveur à serveur) sur l'état réel d'un paiement. */
  abstract getPaymentState(providerRef: string): Promise<ProviderPaymentState>;

  /** Annule un paiement non abouti, pour qu'il ne puisse plus être réglé après coup. */
  abstract cancelIntent(providerRef: string): Promise<void>;

  abstract refund(request: RefundRequest): Promise<RefundOutcome>;

  /**
   * Authentifie un webhook à partir du CORPS BRUT (octets exacts reçus) et de ses en-têtes, puis le normalise.
   * Doit lever `InvalidWebhookSignatureError` si la signature est absente, fausse ou trop ancienne.
   */
  abstract parseWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): WebhookEvent;
}

export class InvalidWebhookSignatureError extends Error {
  constructor(reason: string) {
    super(`Signature de webhook invalide : ${reason}`);
    this.name = 'InvalidWebhookSignatureError';
  }
}

/** Erreur de communication ou refus du prestataire (réseau, quota, paramètre rejeté…). */
export class PaymentProviderError extends Error {
  constructor(
    message: string,
    readonly retryable = true,
  ) {
    super(message);
    this.name = 'PaymentProviderError';
  }
}
