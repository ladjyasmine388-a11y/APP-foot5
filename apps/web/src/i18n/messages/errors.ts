import type { ErrorCode } from '@footfive/shared';
import type { Msg } from './common';

/**
 * Un message par code d'erreur de l'API (le type Record<ErrorCode, …> garantit qu'aucun code n'est oublié :
 * ajouter un code côté serveur casse la compilation du web tant qu'il n'est pas traduit).
 */
export const errorMessages: Record<ErrorCode | 'NETWORK' | 'UNKNOWN', Msg> = {
  VALIDATION_ERROR: {
    fr: 'Certaines informations sont invalides.',
    en: 'Some information is invalid.',
    ar: 'بعض المعلومات غير صحيحة.',
  },
  NOT_FOUND: { fr: 'Élément introuvable.', en: 'Not found.', ar: 'العنصر غير موجود.' },
  FORBIDDEN: {
    fr: 'Vous n’avez pas le droit d’effectuer cette action.',
    en: 'You are not allowed to do this.',
    ar: 'لا تملك صلاحية تنفيذ هذا الإجراء.',
  },
  RATE_LIMITED: {
    fr: 'Trop de tentatives. Patientez un instant avant de réessayer.',
    en: 'Too many attempts. Please wait a moment.',
    ar: 'محاولات كثيرة. انتظر قليلًا ثم أعد المحاولة.',
  },
  INTERNAL_ERROR: {
    fr: 'Une erreur est survenue. Réessayez plus tard.',
    en: 'Something went wrong. Please try again later.',
    ar: 'حدث خطأ. حاول مرة أخرى لاحقًا.',
  },
  CONFLICT: {
    fr: 'Cette action est impossible dans l’état actuel.',
    en: 'This action is not possible right now.',
    ar: 'هذا الإجراء غير ممكن في الوضع الحالي.',
  },
  UNAUTHENTICATED: {
    fr: 'Veuillez vous connecter.',
    en: 'Please sign in.',
    ar: 'يرجى تسجيل الدخول.',
  },
  INVALID_CREDENTIALS: {
    fr: 'Email ou mot de passe incorrect.',
    en: 'Incorrect email or password.',
    ar: 'البريد الإلكتروني أو كلمة المرور غير صحيحة.',
  },
  TOKEN_INVALID: {
    fr: 'Lien ou session invalide.',
    en: 'Invalid link or session.',
    ar: 'رابط أو جلسة غير صالحة.',
  },
  TOKEN_EXPIRED: {
    fr: 'Lien ou session expiré.',
    en: 'Link or session expired.',
    ar: 'انتهت صلاحية الرابط أو الجلسة.',
  },
  REFRESH_REUSED: {
    fr: 'Session fermée par sécurité. Reconnectez-vous.',
    en: 'Session closed for security. Please sign in again.',
    ar: 'تم إغلاق الجلسة لأسباب أمنية. سجّل الدخول من جديد.',
  },
  REFRESH_CONFLICT: {
    fr: 'Session en cours de renouvellement. Réessayez.',
    en: 'Session is being renewed. Try again.',
    ar: 'يجري تجديد الجلسة. أعد المحاولة.',
  },
  ORIGIN_NOT_ALLOWED: {
    fr: 'Origine non autorisée.',
    en: 'Origin not allowed.',
    ar: 'مصدر الطلب غير مسموح.',
  },
  EMAIL_TAKEN: {
    fr: 'Un compte existe déjà avec cet email.',
    en: 'An account already exists with this email.',
    ar: 'يوجد حساب بهذا البريد الإلكتروني.',
  },
  EMAIL_NOT_VERIFIED: {
    fr: 'Vérifiez d’abord votre adresse email.',
    en: 'Please verify your email address first.',
    ar: 'تحقق من بريدك الإلكتروني أولًا.',
  },
  ACCOUNT_BLOCKED: {
    fr: 'Ce compte est suspendu.',
    en: 'This account is suspended.',
    ar: 'هذا الحساب موقوف.',
  },
  INVALID_CURRENT_PASSWORD: {
    fr: 'Mot de passe actuel incorrect.',
    en: 'Current password is incorrect.',
    ar: 'كلمة المرور الحالية غير صحيحة.',
  },
  SLOT_UNAVAILABLE: {
    fr: 'Ce créneau vient d’être pris. Choisissez-en un autre.',
    en: 'This slot was just taken. Please pick another.',
    ar: 'تم حجز هذا الموعد للتو. اختر موعدًا آخر.',
  },
  SLOT_NOT_BOOKABLE: {
    fr: 'Ce créneau n’est pas réservable.',
    en: 'This slot cannot be booked.',
    ar: 'هذا الموعد غير قابل للحجز.',
  },
  TOO_MANY_HOLDS: {
    fr: 'Vous avez trop de réservations en attente de paiement.',
    en: 'You have too many bookings awaiting payment.',
    ar: 'لديك حجوزات كثيرة في انتظار الدفع.',
  },
  BOOKING_NOT_CANCELLABLE: {
    fr: 'Cette réservation ne peut plus être annulée.',
    en: 'This booking can no longer be cancelled.',
    ar: 'لا يمكن إلغاء هذا الحجز بعد الآن.',
  },
  IDEMPOTENCY_KEY_REUSED: {
    fr: 'Requête déjà utilisée avec un contenu différent.',
    en: 'Request already used with different content.',
    ar: 'تم استخدام الطلب سابقًا بمحتوى مختلف.',
  },
  REQUEST_IN_PROGRESS: {
    fr: 'Requête en cours de traitement. Patientez.',
    en: 'Request is being processed. Please wait.',
    ar: 'الطلب قيد المعالجة. انتظر.',
  },
  NOT_CAPTAIN: {
    fr: 'Réservé au capitaine de l’équipe.',
    en: 'Reserved for the team captain.',
    ar: 'مخصص لقائد الفريق.',
  },
  TEAM_LIMIT_REACHED: {
    fr: 'Vous dirigez déjà le nombre maximum d’équipes.',
    en: 'You already captain the maximum number of teams.',
    ar: 'أنت تقود بالفعل الحد الأقصى من الفرق.',
  },
  TEAM_FULL: {
    fr: 'Cette équipe est complète.',
    en: 'This team is full.',
    ar: 'هذا الفريق مكتمل.',
  },
  TEAM_TOO_SMALL: {
    fr: 'L’équipe n’a pas assez de joueurs pour ce format.',
    en: 'The team does not have enough players for this format.',
    ar: 'ليس لدى الفريق عدد كافٍ من اللاعبين لهذا النظام.',
  },
  ALREADY_JOINED: {
    fr: 'Vous participez déjà.',
    en: 'You are already part of this.',
    ar: 'أنت مشارك بالفعل.',
  },
  SESSION_FULL: {
    fr: 'Cette session est complète.',
    en: 'This session is full.',
    ar: 'هذه الجلسة مكتملة.',
  },
  SESSION_CLOSED: {
    fr: 'Inscriptions fermées pour cette activité.',
    en: 'This activity is closed.',
    ar: 'التسجيل مغلق لهذا النشاط.',
  },
  SCHEDULE_CONFLICT: {
    fr: 'Vous avez déjà une activité sur ce créneau.',
    en: 'You already have an activity at this time.',
    ar: 'لديك نشاط آخر في هذا الوقت.',
  },
  LEVEL_INCOMPATIBLE: {
    fr: 'Votre niveau ne correspond pas.',
    en: 'Your level does not match.',
    ar: 'مستواك لا يتوافق.',
  },
  BOOKING_NOT_ELIGIBLE: {
    fr: 'Cette réservation ne peut pas être utilisée ici (confirmée, à venir et non utilisée requise).',
    en: 'This booking cannot be used here (must be confirmed, upcoming and unused).',
    ar: 'لا يمكن استخدام هذا الحجز هنا (يجب أن يكون مؤكدًا وقادمًا وغير مستخدم).',
  },
  BOOKING_NOT_PAYABLE: {
    fr: 'Cette réservation n’est plus payable.',
    en: 'This booking can no longer be paid.',
    ar: 'لم يعد بالإمكان دفع هذا الحجز.',
  },
  PAYMENT_PROVIDER_ERROR: {
    fr: 'Le service de paiement est indisponible. Réessayez.',
    en: 'The payment service is unavailable. Try again.',
    ar: 'خدمة الدفع غير متاحة. أعد المحاولة.',
  },
  INVALID_WEBHOOK_SIGNATURE: {
    fr: 'Signature invalide.',
    en: 'Invalid signature.',
    ar: 'توقيع غير صالح.',
  },
  ACCOUNT_HAS_UPCOMING_BOOKINGS: {
    fr: 'Annulez d’abord vos réservations à venir.',
    en: 'Cancel your upcoming bookings first.',
    ar: 'ألغِ حجوزاتك القادمة أولًا.',
  },
  ACCOUNT_IS_TEAM_CAPTAIN: {
    fr: 'Transférez d’abord vos équipes à un autre capitaine.',
    en: 'Transfer your teams to another captain first.',
    ar: 'انقل فرقك إلى قائد آخر أولًا.',
  },
  NETWORK: {
    fr: 'Connexion impossible. Vérifiez votre réseau.',
    en: 'Cannot connect. Check your network.',
    ar: 'تعذّر الاتصال. تحقق من الشبكة.',
  },
  UNKNOWN: {
    fr: 'Une erreur inattendue est survenue.',
    en: 'An unexpected error occurred.',
    ar: 'حدث خطأ غير متوقع.',
  },
};
