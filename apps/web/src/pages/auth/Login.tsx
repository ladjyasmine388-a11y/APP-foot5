import { loginSchema } from '@footfive/shared';
import { type FormEvent, useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router';
import { Alert, Button, Field, Input } from '../../components/ui';
import { useI18n } from '../../i18n';
import { type FieldErrors, parseForm } from '../../lib/forms';
import { useAuth } from '../../lib/auth';
import { safeNext } from '../../lib/query';
import { AuthShell } from './AuthShell';

export function LoginPage() {
  const { t, tError } = useI18n();
  const { login, status } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const [form, setForm] = useState({ email: '', password: '' });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [failure, setFailure] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  if (status === 'auth') return <Navigate to={next} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const parsed = parseForm(loginSchema, form);
    setErrors(parsed.errors ?? {});
    if (!parsed.data) return;
    setBusy(true);
    setFailure(null);
    try {
      await login(parsed.data);
      navigate(next, { replace: true });
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell
      title={t('auth.login.title')}
      footer={
        <>
          {t('auth.login.noAccount')}{' '}
          <Link className="font-semibold text-brand-700 underline" to={`/register${next !== '/' ? `?next=${encodeURIComponent(next)}` : ''}`}>
            {t('nav.register')}
          </Link>
        </>
      }
    >
      <form onSubmit={submit} noValidate className="space-y-4">
        {failure !== null && <Alert tone="error">{tError(failure)}</Alert>}
        <Field label={t('auth.email')} error={errors['email'] ? t('form.invalidField') : null}>
          {(p) => <Input {...p} type="email" autoComplete="email" inputMode="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />}
        </Field>
        <Field label={t('auth.password')} error={errors['password'] ? t('form.required') : null}>
          {(p) => <Input {...p} type="password" autoComplete="current-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />}
        </Field>
        <Button type="submit" loading={busy} className="w-full">
          {t('auth.login.submit')}
        </Button>
        <p className="text-center text-sm">
          <Link className="text-brand-700 underline" to="/forgot-password">
            {t('auth.login.forgot')}
          </Link>
        </p>
      </form>
    </AuthShell>
  );
}
