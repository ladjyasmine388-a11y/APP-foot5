import type { OpponentListingView } from '@footfive/shared';
import { Link } from 'react-router';
import { PinIcon } from '../../components/icons';
import { Avatar, Badge, Card } from '../../components/ui';
import { type MessageKey, useI18n } from '../../i18n';

export function OpponentCard({ listing }: { listing: OpponentListingView }) {
  const { t, dateTime } = useI18n();
  return (
    <Link to={`/opponents/${listing.id}`} className="block">
      <Card className="h-full transition-shadow hover:shadow-md">
        <div className="flex items-center gap-3">
          <Avatar name={listing.team.name} url={listing.team.logoUrl} size={44} />
          <div className="min-w-0">
            <h3 className="truncate font-semibold">{listing.team.name}</h3>
            <p className="text-xs text-muted">
              {t('teams.memberCount', { n: listing.team.memberCount })} ·{' '}
              {t(`level.${listing.team.level}` as MessageKey)}
            </p>
          </div>
        </div>
        <p className="num mt-3 text-sm font-medium text-brand-800">{dateTime(listing.startsAt)}</p>
        <p className="mt-1 flex items-center gap-1 text-sm text-muted">
          <PinIcon width={16} height={16} />
          {listing.venue.name}, {listing.venue.city}
        </p>
        <div className="mt-3 flex flex-wrap gap-1.5">
          <Badge tone="green">{t('opp.perSide', { n: listing.playersPerSide })}</Badge>
          <Badge>
            {listing.level ? t(`level.${listing.level}` as MessageKey) : t('level.any')}
          </Badge>
          {listing.myRequest && (
            <Badge tone="amber">
              {t('opp.myRequest', {
                status: t(`opp.request.status.${listing.myRequest.status}` as MessageKey),
              })}
            </Badge>
          )}
          {listing.pendingRequests !== null && listing.pendingRequests > 0 && (
            <Badge tone="amber">{t('opp.pending', { n: listing.pendingRequests })}</Badge>
          )}
        </div>
        {listing.comment && (
          <p className="mt-2 line-clamp-2 text-sm text-muted">{listing.comment}</p>
        )}
      </Card>
    </Link>
  );
}
