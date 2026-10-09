import { forgotPasswordSchema, resetPasswordSchema } from '@footfive/shared';
import { type FormEvent, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { Alert, Button, Field, Input } from '../../components/ui';
import { useI18n } from '../../i18n';
import { api } from '../../lib/api';
import { type FieldErrors, parseForm } from '../../lib/forms';
import { AuthShell } from './AuthShell';

export function ForgotPasswordPage() {
  const { t, tError } = useI18n();
  const [email, setEmail] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [failure, setFailure] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const parsed = parseForm(forgotPasswordSchema, { email });
    setErrors(parsed.errors ?? {});
    if (!parsed.data) return;
    setBusy(true);
    setFailure(null);
    try {
      await api('/auth/forgot-password', { method: 'POST', body: parsed.data, auth: false });
      setSent(true); // même message que le compte existe ou non : l'API ne révèle rien
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell
      title={t('auth.forgot.title')}
      subtitle={t('auth.forgot.text')}
      footer={
        <Link className="text-brand-700 underline" to="/login">
          {t('nav.login')}
        </Link>
      }
    >
      {sent ? (
        <Alert tone="success">{t('auth.forgot.sent')}</Alert>
      ) : (
        <form onSubmit={submit} noValidate className="space-y-4">
          {failure !== null && <Alert tone="error">{tError(failure)}</Alert>}
          <Field label={t('auth.email')} error={errors['email'] ? t('form.invalidField') : null}>
            {(p) => (
              <Input
                {...p}
                type="email"
                autoComplete="email"
                inputMode="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            )}
          </Field>
          <Button type="submit" loading={busy} className="w-full">
            {t('auth.forgot.submit')}
          </Button>
        </form>
      )}
    </AuthShell>
  );
}

export function ResetPasswordPage() {
  const { t, tError } = useI18n();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [failure, setFailure] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const parsed = parseForm(resetPasswordSchema, { token: params.get('token') ?? '', password });
    setErrors(parsed.errors ?? {});
    if (!parsed.data) return;
    setBusy(true);
    setFailure(null);
    try {
      await api('/auth/reset-password', { method: 'POST', body: parsed.data, auth: false });
      setDone(true);
      setTimeout(() => navigate('/login'), 2500);
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title={t('auth.reset.title')}>
      {done ? (
        <Alert tone="success">{t('auth.reset.done')}</Alert>
      ) : (
        <form onSubmit={submit} noValidate className="space-y-4">
          {failure !== null && <Alert tone="error">{tError(failure)}</Alert>}
          {errors['token'] && <Alert tone="error">{t('auth.verify.failed')}</Alert>}
          <Field
            label={t('auth.password')}
            hint={t('auth.passwordHint')}
            error={errors['password'] ? t('auth.passwordHint') : null}
          >
            {(p) => (
              <Input
                {...p}
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            )}
          </Field>
          <Button type="submit" loading={busy} className="w-full">
            {t('auth.reset.submit')}
          </Button>
        </form>
      )}
    </AuthShell>
  );
}
