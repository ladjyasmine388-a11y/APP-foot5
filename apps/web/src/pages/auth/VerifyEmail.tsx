import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Alert, LinkButton, Loading } from '../../components/ui';
import { useI18n } from '../../i18n';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { AuthShell } from './AuthShell';

export function VerifyEmailPage() {
  const { t } = useI18n();
  const { status, reload } = useAuth();
  const [params] = useSearchParams();
  const token = params.get('token');
  const [state, setState] = useState<'pending' | 'ok' | 'failed'>(token ? 'pending' : 'failed');
  const started = useRef(false);

  useEffect(() => {
    // Le jeton est à usage unique : en mode strict, React monte deux fois — on n'appelle l'API qu'une fois.
    if (started.current) return;
    started.current = true;
    if (!token) return;
    api('/auth/verify-email', { method: 'POST', body: { token }, auth: false })
      .then(() => {
        setState('ok');
        if (status === 'auth') void reload();
      })
      .catch(() => setState('failed'));
  }, [token, status, reload]);

  return (
    <AuthShell title={t('auth.verify.title')}>
      {state === 'pending' && <Loading />}
      {state === 'ok' && (
        <>
          <Alert tone="success">{t('auth.verify.success')}</Alert>
          <LinkButton to={status === 'auth' ? '/venues' : '/login'} className="w-full">
            {status === 'auth' ? t('nav.venues') : t('nav.login')}
          </LinkButton>
        </>
      )}
      {state === 'failed' && <Alert tone="error">{t('auth.verify.failed')}</Alert>}
    </AuthShell>
  );
}
