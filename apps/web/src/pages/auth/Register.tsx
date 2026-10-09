import { PLAYER_LEVELS, PLAYER_POSITIONS, registerSchema } from '@footfive/shared';
import { type FormEvent, useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router';
import { Alert, Button, Checkbox, Field, Input, LinkButton, Select } from '../../components/ui';
import { type MessageKey, useI18n } from '../../i18n';
import { useAuth } from '../../lib/auth';
import { type FieldErrors, blankToUndefined, parseForm, serverFieldErrors } from '../../lib/forms';
import { safeNext } from '../../lib/query';
import { AuthShell } from './AuthShell';

export function RegisterPage() {
  const { t, tError, locale } = useI18n();
  const { register, status } = useAuth();
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const [form, setForm] = useState({ firstName: '', lastName: '', email: '', phone: '', password: '', city: '', level: 'BEGINNER', preferredPosition: 'ANY', acceptTerms: false });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [failure, setFailure] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  if (status === 'auth' && !done) return <Navigate to={next} replace />;

  if (done) {
    return (
      <AuthShell title={t('auth.register.title')}>
        <Alert tone="success">{t('auth.register.done')}</Alert>
        <LinkButton to={next} className="w-full">
          {t('nav.home')}
        </LinkButton>
      </AuthShell>
    );
  }

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((f) => ({ ...f, [key]: value }));
  const err = (key: string): string | null => (errors[key] ? t(key === 'password' ? 'auth.passwordHint' : 'form.invalidField') : null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const parsed = parseForm(registerSchema, { ...form, city: blankToUndefined(form.city), locale });
    setErrors(parsed.errors ?? {});
    if (!parsed.data) return;
    setBusy(true);
    setFailure(null);
    try {
      await register(parsed.data);
      setDone(true);
    } catch (error) {
      setErrors(serverFieldErrors(error));
      setFailure(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell
      title={t('auth.register.title')}
      subtitle={t('auth.register.subtitle')}
      footer={
        <>
          {t('auth.register.haveAccount')}{' '}
          <Link className="font-semibold text-brand-700 underline" to="/login">
            {t('nav.login')}
          </Link>
        </>
      }
    >
      <form onSubmit={submit} noValidate className="space-y-4">
        {failure !== null && <Alert tone="error">{tError(failure)}</Alert>}
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('auth.firstName')} error={err('firstName')}>
            {(p) => <Input {...p} autoComplete="given-name" value={form.firstName} onChange={(e) => set('firstName', e.target.value)} />}
          </Field>
          <Field label={t('auth.lastName')} error={err('lastName')}>
            {(p) => <Input {...p} autoComplete="family-name" value={form.lastName} onChange={(e) => set('lastName', e.target.value)} />}
          </Field>
        </div>
        <Field label={t('auth.email')} error={err('email')}>
          {(p) => <Input {...p} type="email" autoComplete="email" inputMode="email" value={form.email} onChange={(e) => set('email', e.target.value)} />}
        </Field>
        <Field label={t('auth.phone')} hint={t('auth.phoneHint')} error={err('phone')}>
          {(p) => <Input {...p} type="tel" autoComplete="tel" inputMode="tel" value={form.phone} onChange={(e) => set('phone', e.target.value)} />}
        </Field>
        <Field label={t('auth.password')} hint={t('auth.passwordHint')} error={err('password')}>
          {(p) => <Input {...p} type="password" autoComplete="new-password" value={form.password} onChange={(e) => set('password', e.target.value)} />}
        </Field>
        <Field label={t('auth.city')} optional>
          {(p) => <Input {...p} autoComplete="address-level2" value={form.city} onChange={(e) => set('city', e.target.value)} />}
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('auth.level')}>
            {(p) => (
              <Select {...p} value={form.level} onChange={(e) => set('level', e.target.value)}>
                {PLAYER_LEVELS.map((l) => <option key={l} value={l}>{t(`level.${l}` as MessageKey)}</option>)}
              </Select>
            )}
          </Field>
          <Field label={t('auth.position')}>
            {(p) => (
              <Select {...p} value={form.preferredPosition} onChange={(e) => set('preferredPosition', e.target.value)}>
                {PLAYER_POSITIONS.map((l) => <option key={l} value={l}>{t(`position.${l}` as MessageKey)}</option>)}
              </Select>
            )}
          </Field>
        </div>
        <div>
          <Checkbox label={t('auth.acceptTerms')} checked={form.acceptTerms} onChange={(e) => set('acceptTerms', e.target.checked)} />
          {errors['acceptTerms'] && <p className="mt-1 text-xs font-medium text-red-600">{t('form.required')}</p>}
        </div>
        <Button type="submit" loading={busy} className="w-full">
          {t('auth.register.submit')}
        </Button>
      </form>
    </AuthShell>
  );
}
