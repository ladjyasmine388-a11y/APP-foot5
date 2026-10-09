import type { SoloSessionView } from '@footfive/shared';
import { Link } from 'react-router';
import { PinIcon } from '../../components/icons';
import { Badge, Card } from '../../components/ui';
import { type MessageKey, useI18n } from '../../i18n';

export function SoloCard({ session }: { session: SoloSessionView }) {
  const { t, dateTime, money } = useI18n();
  const remaining = session.remaining;
  return (
    <Link to={`/solo/${session.id}`} className="block">
      <Card className="h-full transition-shadow hover:shadow-md">
        <div className="flex items-start justify-between gap-2">
          <h3 className="font-semibold">{session.venue.name}</h3>
          {session.joined ? <Badge tone="green">{t('solo.joined')}</Badge> : remaining === 0 ? <Badge>{t('solo.full')}</Badge> : <Badge tone="amber">{t('solo.spots', { n: remaining, total: session.spots })}</Badge>}
        </div>
        <p className="num mt-1 text-sm font-medium text-brand-800">{dateTime(session.startsAt)}</p>
        <p className="mt-1 flex items-center gap-1 text-sm text-muted"><PinIcon width={16} height={16} />{session.venue.city} · {session.field.name}</p>
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <Badge>{session.level ? t(`level.${session.level}` as MessageKey) : t('level.any')}</Badge>
          {session.pricePerPlayerMinor > 0 && <Badge>{money(session.pricePerPlayerMinor)}</Badge>}
          <span className="text-xs text-muted">{t('solo.host', { name: session.host.name })}</span>
        </div>
      </Card>
    </Link>
  );
}
