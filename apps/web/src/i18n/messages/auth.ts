import type { Msg } from './common';

export const auth = {
  'form.invalidField': { fr: 'Valeur invalide', en: 'Invalid value', ar: 'قيمة غير صحيحة' },
  'form.required': { fr: 'Champ requis', en: 'Required field', ar: 'حقل مطلوب' },
  'form.fixErrors': { fr: 'Corrigez les champs en rouge.', en: 'Please fix the highlighted fields.', ar: 'صحّح الحقول المظللة.' },

  'auth.email': { fr: 'Adresse email', en: 'Email address', ar: 'البريد الإلكتروني' },
  'auth.password': { fr: 'Mot de passe', en: 'Password', ar: 'كلمة المرور' },
  'auth.passwordHint': { fr: '10 caractères minimum, pas trop courant.', en: 'At least 10 characters, not too common.', ar: '10 أحرف على الأقل، وغير شائعة.' },
  'auth.firstName': { fr: 'Prénom', en: 'First name', ar: 'الاسم الأول' },
  'auth.lastName': { fr: 'Nom', en: 'Last name', ar: 'اللقب' },
  'auth.phone': { fr: 'Téléphone', en: 'Phone', ar: 'الهاتف' },
  'auth.phoneHint': { fr: 'Ex. 0550 12 34 56', en: 'E.g. 0550 12 34 56', ar: 'مثال: 0550 12 34 56' },
  'auth.city': { fr: 'Ville', en: 'City', ar: 'المدينة' },
  'auth.level': { fr: 'Niveau de jeu', en: 'Playing level', ar: 'مستوى اللعب' },
  'auth.position': { fr: 'Poste préféré', en: 'Preferred position', ar: 'المركز المفضل' },
  'auth.birthDate': { fr: 'Date de naissance', en: 'Date of birth', ar: 'تاريخ الميلاد' },
  'auth.acceptTerms': { fr: 'J’accepte les conditions d’utilisation et la politique de confidentialité.', en: 'I accept the terms of use and the privacy policy.', ar: 'أوافق على شروط الاستخدام وسياسة الخصوصية.' },

  'auth.login.title': { fr: 'Connexion', en: 'Sign in', ar: 'تسجيل الدخول' },
  'auth.login.submit': { fr: 'Se connecter', en: 'Sign in', ar: 'دخول' },
  'auth.login.forgot': { fr: 'Mot de passe oublié ?', en: 'Forgot password?', ar: 'نسيت كلمة المرور؟' },
  'auth.login.noAccount': { fr: 'Pas encore de compte ?', en: 'No account yet?', ar: 'ليس لديك حساب؟' },

  'auth.register.title': { fr: 'Créer un compte', en: 'Create an account', ar: 'إنشاء حساب' },
  'auth.register.subtitle': { fr: 'Réservez des terrains, rejoignez des équipes, trouvez des adversaires.', en: 'Book pitches, join teams, find opponents.', ar: 'احجز ملاعب، انضم إلى فرق، واعثر على خصوم.' },
  'auth.register.submit': { fr: 'Créer mon compte', en: 'Create my account', ar: 'إنشاء حسابي' },
  'auth.register.haveAccount': { fr: 'Déjà un compte ?', en: 'Already have an account?', ar: 'لديك حساب بالفعل؟' },
  'auth.register.done': {
    fr: 'Compte créé ! Un email de confirmation vous a été envoyé : cliquez sur le lien pour pouvoir réserver.',
    en: 'Account created! A confirmation email was sent: click the link so you can book.',
    ar: 'تم إنشاء الحساب! أُرسلت رسالة تأكيد: اضغط على الرابط لتتمكن من الحجز.',
  },

  'auth.verify.title': { fr: 'Confirmation de l’email', en: 'Email confirmation', ar: 'تأكيد البريد الإلكتروني' },
  'auth.verify.progress': { fr: 'Vérification en cours…', en: 'Verifying…', ar: 'جارٍ التحقق…' },
  'auth.verify.success': { fr: 'Votre adresse email est confirmée. Vous pouvez réserver.', en: 'Your email address is confirmed. You can now book.', ar: 'تم تأكيد بريدك الإلكتروني. يمكنك الحجز الآن.' },
  'auth.verify.failed': { fr: 'Ce lien est invalide ou a expiré.', en: 'This link is invalid or has expired.', ar: 'هذا الرابط غير صالح أو انتهت صلاحيته.' },
  'auth.verify.banner': { fr: 'Confirmez votre adresse email pour pouvoir réserver.', en: 'Confirm your email address to be able to book.', ar: 'أكّد بريدك الإلكتروني لتتمكن من الحجز.' },
  'auth.verify.resend': { fr: 'Renvoyer l’email', en: 'Resend email', ar: 'إعادة إرسال الرسالة' },
  'auth.verify.resent': { fr: 'Email renvoyé si le compte existe.', en: 'Email sent if the account exists.', ar: 'تم إرسال الرسالة إن كان الحساب موجودًا.' },

  'auth.forgot.title': { fr: 'Mot de passe oublié', en: 'Forgot password', ar: 'نسيت كلمة المرور' },
  'auth.forgot.text': { fr: 'Indiquez votre email : si un compte existe, vous recevrez un lien pour choisir un nouveau mot de passe.', en: 'Enter your email: if an account exists, you will receive a link to choose a new password.', ar: 'أدخل بريدك الإلكتروني: إن وُجد حساب ستصلك رسالة برابط لاختيار كلمة مرور جديدة.' },
  'auth.forgot.submit': { fr: 'Envoyer le lien', en: 'Send link', ar: 'إرسال الرابط' },
  'auth.forgot.sent': { fr: 'Si un compte existe avec cet email, un lien vient de lui être envoyé.', en: 'If an account exists with this email, a link has just been sent.', ar: 'إن وُجد حساب بهذا البريد فقد أُرسل إليه رابط.' },

  'auth.reset.title': { fr: 'Nouveau mot de passe', en: 'New password', ar: 'كلمة مرور جديدة' },
  'auth.reset.submit': { fr: 'Changer le mot de passe', en: 'Change password', ar: 'تغيير كلمة المرور' },
  'auth.reset.done': { fr: 'Mot de passe changé. Vous pouvez vous connecter.', en: 'Password changed. You can sign in.', ar: 'تم تغيير كلمة المرور. يمكنك تسجيل الدخول.' },
} as const satisfies Record<string, Msg>;
