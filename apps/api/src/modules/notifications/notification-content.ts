import { DEFAULT_LOCALE, LOCALES, type Locale, type NotificationType } from '@footfive/shared';

export type NotificationData = Record<string, string | number | null>;
export interface Rendered {
  title: string;
  body: string;
}

const TIME_ZONE = 'Africa/Algiers';

const LOCALE_TAG: Record<Locale, string> = { fr: 'fr-FR', en: 'en-GB', ar: 'ar-DZ' };

/** Date et heure lisibles, en heure d'Alger, dans la langue du destinataire. */
export function formatWhen(iso: unknown, locale: Locale): string {
  const date = typeof iso === 'string' ? new Date(iso) : null;
  if (!date || Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(LOCALE_TAG[locale], {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: TIME_ZONE,
  }).format(date);
}

/** Valeur d'affichage : jamais « undefined » ni « null » dans un message. */
const str = (d: NotificationData, key: string, fallback = '—'): string => {
  const v = d[key];
  return v === null || v === undefined || v === '' ? fallback : String(v);
};

interface Ctx {
  d: NotificationData;
  when: string;
  s: (key: string) => string;
}
type Builder = (c: Ctx) => Rendered;
type Catalog = Record<NotificationType, Record<Locale, Builder>>;

/**
 * Textes des notifications dans les trois langues. Le client web peut aussi les retraduire depuis `type` + `data` ;
 * ces versions servent à l'email et au mobile. Aucune donnée personnelle (email, téléphone) n'y figure.
 */
const CATALOG: Catalog = {
  BOOKING_CONFIRMED: {
    fr: ({ s, when }) => ({
      title: 'Réservation confirmée',
      body: `Votre réservation ${s('reference')} à ${s('venueName')} est confirmée pour ${when}.`,
    }),
    en: ({ s, when }) => ({
      title: 'Booking confirmed',
      body: `Your booking ${s('reference')} at ${s('venueName')} is confirmed for ${when}.`,
    }),
    ar: ({ s, when }) => ({
      title: 'تم تأكيد الحجز',
      body: `تم تأكيد حجزك ${s('reference')} في ${s('venueName')} بتاريخ ${when}.`,
    }),
  },
  PAYMENT_CONFIRMED: {
    fr: ({ s }) => ({
      title: 'Paiement reçu',
      body: `Votre paiement pour la réservation ${s('reference')} a bien été reçu.`,
    }),
    en: ({ s }) => ({
      title: 'Payment received',
      body: `Your payment for booking ${s('reference')} has been received.`,
    }),
    ar: ({ s }) => ({ title: 'تم استلام الدفع', body: `تم استلام دفعتك للحجز ${s('reference')}.` }),
  },
  BOOKING_CANCELLED: {
    fr: ({ s, when }) => ({
      title: 'Réservation annulée',
      body: `Votre réservation ${s('reference')} à ${s('venueName')} (${when}) a été annulée.`,
    }),
    en: ({ s, when }) => ({
      title: 'Booking cancelled',
      body: `Your booking ${s('reference')} at ${s('venueName')} (${when}) has been cancelled.`,
    }),
    ar: ({ s, when }) => ({
      title: 'تم إلغاء الحجز',
      body: `تم إلغاء حجزك ${s('reference')} في ${s('venueName')} (${when}).`,
    }),
  },
  BOOKING_EXPIRED: {
    fr: ({ s }) => ({
      title: 'Réservation expirée',
      body: `Le délai de paiement de la réservation ${s('reference')} est dépassé : le créneau a été libéré.`,
    }),
    en: ({ s }) => ({
      title: 'Booking expired',
      body: `The payment window for booking ${s('reference')} has passed: the slot has been released.`,
    }),
    ar: ({ s }) => ({
      title: 'انتهت مهلة الحجز',
      body: `انتهت مهلة دفع الحجز ${s('reference')}: تم تحرير الموعد.`,
    }),
  },
  REFUND_PROCESSED: {
    fr: ({ s }) => ({
      title: 'Remboursement effectué',
      body: `Un remboursement de ${s('amountMinor')} DA a été effectué pour la réservation ${s('reference')}.`,
    }),
    en: ({ s }) => ({
      title: 'Refund processed',
      body: `A refund of ${s('amountMinor')} DZD has been issued for booking ${s('reference')}.`,
    }),
    ar: ({ s }) => ({
      title: 'تم الاسترداد',
      body: `تم استرداد مبلغ ${s('amountMinor')} دج للحجز ${s('reference')}.`,
    }),
  },
  SOLO_ALMOST_FULL: {
    fr: ({ s, when }) => ({
      title: 'Plus que quelques places',
      body: `Votre session à ${s('venueName')} (${when}) est presque complète : il reste ${s('remaining')} place(s).`,
    }),
    en: ({ s, when }) => ({
      title: 'Almost full',
      body: `Your session at ${s('venueName')} (${when}) is almost full: ${s('remaining')} spot(s) left.`,
    }),
    ar: ({ s, when }) => ({
      title: 'اكتملت تقريبًا',
      body: `جلستك في ${s('venueName')} (${when}) شبه مكتملة: تبقّى ${s('remaining')} مكان.`,
    }),
  },
  SOLO_FULL: {
    fr: ({ s, when }) => ({
      title: 'Session complète',
      body: `La session à ${s('venueName')} (${when}) est complète. À vous de jouer !`,
    }),
    en: ({ s, when }) => ({
      title: 'Session full',
      body: `The session at ${s('venueName')} (${when}) is full. Game on!`,
    }),
    ar: ({ s, when }) => ({
      title: 'اكتملت الجلسة',
      body: `اكتملت الجلسة في ${s('venueName')} (${when}). استعدّوا للعب!`,
    }),
  },
  SOLO_CANCELLED: {
    fr: ({ s, when }) => ({
      title: 'Session annulée',
      body: `La session à ${s('venueName')} (${when}) a été annulée.`,
    }),
    en: ({ s, when }) => ({
      title: 'Session cancelled',
      body: `The session at ${s('venueName')} (${when}) has been cancelled.`,
    }),
    ar: ({ s, when }) => ({
      title: 'تم إلغاء الجلسة',
      body: `تم إلغاء الجلسة في ${s('venueName')} (${when}).`,
    }),
  },
  TEAM_INVITATION_RECEIVED: {
    fr: ({ s }) => ({
      title: 'Invitation à rejoindre une équipe',
      body: `${s('invitedBy')} vous invite à rejoindre l'équipe « ${s('teamName')} ».`,
    }),
    en: ({ s }) => ({
      title: 'Team invitation',
      body: `${s('invitedBy')} invites you to join the team "${s('teamName')}".`,
    }),
    ar: ({ s }) => ({
      title: 'دعوة للانضمام إلى فريق',
      body: `${s('invitedBy')} يدعوك للانضمام إلى الفريق «${s('teamName')}».`,
    }),
  },
  TEAM_INVITATION_ACCEPTED: {
    fr: ({ s }) => ({
      title: 'Nouveau membre',
      body: `${s('playerName')} a rejoint votre équipe « ${s('teamName')} ».`,
    }),
    en: ({ s }) => ({
      title: 'New member',
      body: `${s('playerName')} joined your team "${s('teamName')}".`,
    }),
    ar: ({ s }) => ({
      title: 'عضو جديد',
      body: `انضمّ ${s('playerName')} إلى فريقك «${s('teamName')}».`,
    }),
  },
  OPPONENT_REQUEST_RECEIVED: {
    fr: ({ s, when }) => ({
      title: 'Demande de match reçue',
      body: `L'équipe « ${s('teamName')} » souhaite vous affronter à ${s('venueName')} (${when}).`,
    }),
    en: ({ s, when }) => ({
      title: 'Match request received',
      body: `Team "${s('teamName')}" wants to play you at ${s('venueName')} (${when}).`,
    }),
    ar: ({ s, when }) => ({
      title: 'طلب مباراة',
      body: `الفريق «${s('teamName')}» يريد مواجهتكم في ${s('venueName')} (${when}).`,
    }),
  },
  OPPONENT_ACCEPTED: {
    fr: ({ s, when }) => ({
      title: 'Match confirmé',
      body: `L'équipe « ${s('teamName')} » a accepté votre demande : rendez-vous à ${s('venueName')} (${when}).`,
    }),
    en: ({ s, when }) => ({
      title: 'Match confirmed',
      body: `Team "${s('teamName')}" accepted your request: see you at ${s('venueName')} (${when}).`,
    }),
    ar: ({ s, when }) => ({
      title: 'تم تأكيد المباراة',
      body: `قبل الفريق «${s('teamName')}» طلبكم: الموعد في ${s('venueName')} (${when}).`,
    }),
  },
  OPPONENT_REJECTED: {
    fr: ({ s, when }) => ({
      title: 'Demande non retenue',
      body: `Votre demande pour le match à ${s('venueName')} (${when}) n'a pas été retenue.`,
    }),
    en: ({ s, when }) => ({
      title: 'Request declined',
      body: `Your request for the match at ${s('venueName')} (${when}) was not accepted.`,
    }),
    ar: ({ s, when }) => ({
      title: 'لم يُقبل الطلب',
      body: `لم يتم قبول طلبكم للمباراة في ${s('venueName')} (${when}).`,
    }),
  },
  MATCH_CANCELLED: {
    fr: ({ s, when }) => ({
      title: 'Match annulé',
      body: `Le match à ${s('venueName')} (${when}) a été annulé.`,
    }),
    en: ({ s, when }) => ({
      title: 'Match cancelled',
      body: `The match at ${s('venueName')} (${when}) has been cancelled.`,
    }),
    ar: ({ s, when }) => ({
      title: 'تم إلغاء المباراة',
      body: `تم إلغاء المباراة في ${s('venueName')} (${when}).`,
    }),
  },
  MATCH_REMINDER: {
    fr: ({ s, when }) => ({
      title: 'Rappel : match à venir',
      body: `Vous jouez à ${s('venueName')} (${when}). N'oubliez pas votre équipement !`,
    }),
    en: ({ s, when }) => ({
      title: 'Reminder: upcoming match',
      body: `You play at ${s('venueName')} (${when}). Don't forget your kit!`,
    }),
    ar: ({ s, when }) => ({
      title: 'تذكير: مباراة قادمة',
      body: `ستلعب في ${s('venueName')} (${when}). لا تنسَ عتادك!`,
    }),
  },
  VENUE_APPROVED: {
    fr: ({ s }) => ({
      title: 'Complexe approuvé',
      body: `Votre complexe « ${s('venueName')} » est approuvé et visible des joueurs.`,
    }),
    en: ({ s }) => ({
      title: 'Venue approved',
      body: `Your venue "${s('venueName')}" is approved and visible to players.`,
    }),
    ar: ({ s }) => ({
      title: 'تمت الموافقة على المجمّع',
      body: `تمت الموافقة على مجمّعك «${s('venueName')}» وأصبح ظاهرًا للاعبين.`,
    }),
  },
  VENUE_SUSPENDED: {
    fr: ({ s }) => ({
      title: 'Complexe suspendu',
      body: `Votre complexe « ${s('venueName')} » a été suspendu et n'est plus visible. Motif : ${s('reason')}`,
    }),
    en: ({ s }) => ({
      title: 'Venue suspended',
      body: `Your venue "${s('venueName')}" has been suspended and is no longer visible. Reason: ${s('reason')}`,
    }),
    ar: ({ s }) => ({
      title: 'تم تعليق المجمّع',
      body: `تم تعليق مجمّعك «${s('venueName')}» ولم يعد ظاهرًا. السبب: ${s('reason')}`,
    }),
  },
  VENUE_REJECTED: {
    fr: ({ s }) => ({
      title: 'Complexe refusé',
      body: `Votre demande pour « ${s('venueName')} » a été refusée. Motif : ${s('reason')}`,
    }),
    en: ({ s }) => ({
      title: 'Venue rejected',
      body: `Your request for "${s('venueName')}" was rejected. Reason: ${s('reason')}`,
    }),
    ar: ({ s }) => ({
      title: 'تم رفض المجمّع',
      body: `تم رفض طلبك الخاص بـ «${s('venueName')}». السبب: ${s('reason')}`,
    }),
  },
};

export const notificationTypes = Object.keys(CATALOG) as NotificationType[];

export function normalizeLocale(value: string | null | undefined): Locale {
  return (LOCALES as readonly string[]).includes(value ?? '') ? (value as Locale) : DEFAULT_LOCALE;
}

export function renderNotification(
  type: NotificationType,
  data: NotificationData,
  localeInput: string | null | undefined,
): Rendered {
  const locale = normalizeLocale(localeInput);
  return CATALOG[type][locale]({
    d: data,
    when: formatWhen(data.startsAt, locale),
    s: (key) => str(data, key),
  });
}

/** Types qui déclenchent aussi un email (les autres restent dans l'application). */
export const EMAIL_NOTIFICATION_TYPES: ReadonlySet<NotificationType> = new Set<NotificationType>([
  'BOOKING_CONFIRMED',
  'BOOKING_CANCELLED',
  'BOOKING_EXPIRED',
  'REFUND_PROCESSED',
  'SOLO_FULL',
  'SOLO_CANCELLED',
  'TEAM_INVITATION_RECEIVED',
  'OPPONENT_REQUEST_RECEIVED',
  'OPPONENT_ACCEPTED',
  'MATCH_CANCELLED',
  'MATCH_REMINDER',
  'VENUE_APPROVED',
  'VENUE_SUSPENDED',
  'VENUE_REJECTED',
]);
