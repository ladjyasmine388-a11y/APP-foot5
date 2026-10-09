import type { BookingView, CancellationPolicy, ManageBookingView } from '@footfive/shared';
import type { Prisma } from '../../generated/prisma/client.js';
import { decideRefund, freeCancellationDeadline } from './cancellation.js';

/** Relations chargées pour construire la vue d'un JOUEUR. */
export const bookingInclude = {
  venue: {
    select: {
      id: true,
      slug: true,
      name: true,
      city: true,
      address: true,
      phone: true,
      cancellationPolicy: true,
    },
  },
  field: { select: { id: true, name: true } },
  payments: {
    select: { id: true, amountMinor: true, status: true, checkoutUrl: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  },
} satisfies Prisma.BookingInclude;
export type BookingWithRelations = Prisma.BookingGetPayload<{ include: typeof bookingInclude }>;

/** Relations chargées pour la vue du PERSONNEL du complexe (contact du client en plus). */
export const manageBookingInclude = {
  field: { select: { id: true, name: true } },
  payments: { select: { amountMinor: true, status: true } },
  customer: { select: { firstName: true, lastName: true, phone: true, status: true } },
} satisfies Prisma.BookingInclude;
export type ManageBookingWithRelations = Prisma.BookingGetPayload<{
  include: typeof manageBookingInclude;
}>;

type BookingStatus = BookingView['status'];

/**
 * Statut RÉEL à cet instant : un verrou de paiement dépassé est un « EXPIRED », même si le job de nettoyage
 * ne l'a pas encore constaté. L'utilisateur ne voit donc jamais une réservation fantôme.
 */
export function effectiveStatus(
  row: { status: BookingStatus; holdExpiresAt: Date | null },
  now: Date,
): BookingStatus {
  return row.status === 'PENDING_PAYMENT' && (!row.holdExpiresAt || row.holdExpiresAt <= now)
    ? 'EXPIRED'
    : row.status;
}

/** Somme réellement encaissée en ligne : uniquement les paiements CONFIRMÉS PAR LE SERVEUR. */
export function paidOnlineMinor(
  payments: readonly { amountMinor: number; status: string }[],
): number {
  return payments
    .filter((p) => p.status === 'SUCCEEDED' || p.status === 'PARTIALLY_REFUNDED')
    .reduce((sum, p) => sum + p.amountMinor, 0);
}

/** Dernier paiement (le plus récent) ; l'adresse de paiement n'est donnée que tant qu'il est en cours. */
function latestPayment(payments: BookingWithRelations['payments']): BookingView['payment'] {
  const latest = payments[0];
  if (!latest) return null;
  const inFlight = latest.status === 'INITIATED' || latest.status === 'PENDING';
  return {
    id: latest.id,
    status: latest.status,
    checkoutUrl: inFlight ? latest.checkoutUrl : null,
  };
}

export function toBookingView(
  row: BookingWithRelations,
  policy: CancellationPolicy,
  now: Date,
): BookingView {
  const status = effectiveStatus(row, now);
  const paid = paidOnlineMinor(row.payments);
  const allowed =
    status === 'PENDING_PAYMENT' ||
    (status === 'CONFIRMED' && row.startsAt.getTime() > now.getTime());

  return {
    id: row.id,
    reference: row.reference,
    status,
    venue: {
      id: row.venue.id,
      slug: row.venue.slug,
      name: row.venue.name,
      city: row.venue.city,
      address: row.venue.address,
      phone: row.venue.phone,
    },
    field: row.field,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    paymentMode: row.paymentMode,
    priceMinor: row.basePriceMinor,
    feesMinor: row.feesMinor,
    taxMinor: row.taxMinor,
    totalMinor: row.totalMinor,
    dueOnlineMinor: row.dueOnlineMinor,
    dueOnSiteMinor: row.dueOnSiteMinor,
    paidOnlineMinor: paid,
    currency: 'DZD',
    holdExpiresAt: status === 'PENDING_PAYMENT' ? (row.holdExpiresAt?.toISOString() ?? null) : null,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    cancellationReason: row.cancellationReason,
    createdAt: row.createdAt.toISOString(),
    cancellation: {
      allowed,
      freeUntil: allowed ? freeCancellationDeadline(row.startsAt, policy).toISOString() : null,
      refundable:
        allowed &&
        decideRefund({
          paidOnlineMinor: paid,
          startsAt: row.startsAt,
          now,
          policy,
          initiator: 'PLAYER',
        }).eligible,
    },
    payment: latestPayment(row.payments),
  };
}

export function toManageBookingView(row: ManageBookingWithRelations, now: Date): ManageBookingView {
  let customer: ManageBookingView['customer'] = null;
  if (row.customer) {
    customer =
      row.customer.status === 'DELETED'
        ? { name: 'Utilisateur supprimé', phone: null }
        : {
            name: `${row.customer.firstName} ${row.customer.lastName}`,
            phone: row.customer.phone || null,
          };
  } else if (row.customerName) {
    customer = { name: row.customerName, phone: row.customerPhone };
  }

  return {
    id: row.id,
    reference: row.reference,
    status: effectiveStatus(row, now),
    bookingType: row.bookingType,
    source: row.source,
    field: row.field,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    customer,
    note: row.note,
    paymentMode: row.paymentMode,
    priceMinor: row.basePriceMinor,
    totalMinor: row.totalMinor,
    venueAmountMinor: row.venueAmountMinor,
    commissionMinor: row.commissionMinor,
    dueOnlineMinor: row.dueOnlineMinor,
    dueOnSiteMinor: row.dueOnSiteMinor,
    paidOnlineMinor: paidOnlineMinor(row.payments),
    holdExpiresAt: row.holdExpiresAt?.toISOString() ?? null,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    cancellationReason: row.cancellationReason,
    createdAt: row.createdAt.toISOString(),
  };
}
