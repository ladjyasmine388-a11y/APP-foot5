import { DEFAULT_LOCALE, LOCALES, type Locale } from '@footfive/shared';
import type { MailMessage } from './mailer.js';

type Template = (p: { name: string; link?: string }) => { subject: string; text: string };

/** Gabarits d'email dans les trois langues de la plateforme. */
const verifyEmail: Record<Locale, Template> = {
  fr: ({ name, link }) => ({
    subject: 'Confirmez votre adresse email — Foot Five',
    text: `Bonjour ${name},\n\nBienvenue sur Foot Five ! Confirmez votre adresse email en ouvrant ce lien (valable 24 h) :\n${link}\n\nSi vous n'êtes pas à l'origine de cette inscription, ignorez ce message.`,
  }),
  en: ({ name, link }) => ({
    subject: 'Confirm your email address — Foot Five',
    text: `Hello ${name},\n\nWelcome to Foot Five! Confirm your email address by opening this link (valid for 24 hours):\n${link}\n\nIf you did not create this account, you can ignore this message.`,
  }),
  ar: ({ name, link }) => ({
    subject: 'أكّد بريدك الإلكتروني — Foot Five',
    text: `مرحبًا ${name}،\n\nمرحبًا بك في Foot Five! أكّد بريدك الإلكتروني عبر فتح هذا الرابط (صالح لمدة 24 ساعة):\n${link}\n\nإذا لم تقم بإنشاء هذا الحساب، يمكنك تجاهل هذه الرسالة.`,
  }),
};

const resetPassword: Record<Locale, Template> = {
  fr: ({ name, link }) => ({
    subject: 'Réinitialisation de votre mot de passe — Foot Five',
    text: `Bonjour ${name},\n\nPour choisir un nouveau mot de passe, ouvrez ce lien (valable 1 h) :\n${link}\n\nSi vous n'avez rien demandé, ignorez ce message : votre mot de passe reste inchangé.`,
  }),
  en: ({ name, link }) => ({
    subject: 'Reset your password — Foot Five',
    text: `Hello ${name},\n\nTo choose a new password, open this link (valid for 1 hour):\n${link}\n\nIf you did not request this, ignore this message: your password stays unchanged.`,
  }),
  ar: ({ name, link }) => ({
    subject: 'إعادة تعيين كلمة المرور — Foot Five',
    text: `مرحبًا ${name}،\n\nلاختيار كلمة مرور جديدة، افتح هذا الرابط (صالح لمدة ساعة):\n${link}\n\nإذا لم تطلب ذلك، تجاهل هذه الرسالة: ستبقى كلمة مرورك كما هي.`,
  }),
};

const passwordChanged: Record<Locale, Template> = {
  fr: ({ name }) => ({
    subject: 'Votre mot de passe a été modifié — Foot Five',
    text: `Bonjour ${name},\n\nVotre mot de passe vient d'être modifié et vos autres appareils ont été déconnectés.\nSi ce n'était pas vous, réinitialisez-le immédiatement via « Mot de passe oublié ».`,
  }),
  en: ({ name }) => ({
    subject: 'Your password was changed — Foot Five',
    text: `Hello ${name},\n\nYour password was just changed and your other devices were signed out.\nIf this was not you, reset it immediately using "Forgot password".`,
  }),
  ar: ({ name }) => ({
    subject: 'تم تغيير كلمة مرورك — Foot Five',
    text: `مرحبًا ${name}،\n\nتم تغيير كلمة مرورك للتو وتم تسجيل خروج أجهزتك الأخرى.\nإذا لم تكن أنت، أعد تعيينها فورًا عبر «نسيت كلمة المرور».`,
  }),
};

function resolveLocale(locale: string): Locale {
  return (LOCALES as readonly string[]).includes(locale) ? (locale as Locale) : DEFAULT_LOCALE;
}

export const mailTemplates = {
  verifyEmail: (to: string, locale: string, p: { name: string; link: string }): MailMessage => ({
    to,
    ...verifyEmail[resolveLocale(locale)](p),
  }),
  resetPassword: (to: string, locale: string, p: { name: string; link: string }): MailMessage => ({
    to,
    ...resetPassword[resolveLocale(locale)](p),
  }),
  passwordChanged: (to: string, locale: string, p: { name: string }): MailMessage => ({
    to,
    ...passwordChanged[resolveLocale(locale)](p),
  }),
};
