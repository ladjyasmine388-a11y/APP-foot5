import { LinkButton, EmptyState } from '../components/ui';
import { useI18n } from '../i18n';

export function NotFoundPage() {
  const { t } = useI18n();
  return (
    <EmptyState
      title={t('page.notFound.title')}
      text={t('page.notFound.text')}
      action={<LinkButton to="/">{t('nav.home')}</LinkButton>}
    />
  );
}

export function ForbiddenPage() {
  const { t } = useI18n();
  return (
    <EmptyState
      title={t('page.forbidden.title')}
      text={t('page.forbidden.text')}
      action={<LinkButton to="/">{t('nav.home')}</LinkButton>}
    />
  );
}
