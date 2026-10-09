import type { ManageVenueDetail } from '@footfive/shared';
import { useQuery } from '@tanstack/react-query';
import { NavLink, Outlet, useOutletContext, useParams } from 'react-router';
import {
  Alert,
  Badge,
  EmptyState,
  ErrorState,
  LinkButton,
  Loading,
  PageHeader,
  cx,
} from '../../components/ui';
import { type MessageKey, useI18n } from '../../i18n';
import { ApiError, api } from '../../lib/api';
import { STATUS_TONE } from './ManageHome';

export interface VenueContext {
  venue: ManageVenueDetail;
  venueId: string;
  /** Au moins ce rôle (STAFF < MANAGER < OWNER ; l'administrateur de la plateforme les a tous). */
  can: (min: 'STAFF' | 'MANAGER' | 'OWNER') => boolean;
  reload: () => void;
}
export const useVenue = (): VenueContext => useOutletContext<VenueContext>();

const RANK = { STAFF: 1, MANAGER: 2, OWNER: 3, ADMIN: 4 } as const;

const TABS: { path: string; label: MessageKey; min: 'STAFF' | 'MANAGER' }[] = [
  { path: 'bookings', label: 'manage.tab.bookings', min: 'STAFF' },
  { path: 'fields', label: 'manage.tab.fields', min: 'MANAGER' },
  { path: 'hours', label: 'manage.tab.hours', min: 'MANAGER' },
  { path: 'info', label: 'manage.tab.info', min: 'MANAGER' },
  { path: 'staff', label: 'manage.tab.staff', min: 'MANAGER' },
  { path: 'stats', label: 'manage.tab.stats', min: 'MANAGER' },
];

export function VenueManageLayout() {
  const { venueId = '' } = useParams();
  const { t } = useI18n();
  const query = useQuery({
    queryKey: ['manage', 'venue', venueId],
    queryFn: () => api<ManageVenueDetail>(`/manage/venues/${venueId}`),
  });

  if (query.isPending) return <Loading />;
  if (query.isError) {
    return query.error instanceof ApiError && query.error.status === 404 ? (
      <EmptyState
        title={t('page.notFound.title')}
        action={<LinkButton to="/manage">{t('manage.title')}</LinkButton>}
      />
    ) : (
      <ErrorState error={query.error} onRetry={() => void query.refetch()} />
    );
  }
  const venue = query.data;
  const can = (min: 'STAFF' | 'MANAGER' | 'OWNER') => RANK[venue.role] >= RANK[min];
  const ctx: VenueContext = { venue, venueId, can, reload: () => void query.refetch() };

  return (
    <>
      <PageHeader
        title={venue.name}
        subtitle={`${venue.city} · ${t(`manage.role.${venue.role}` as MessageKey)}`}
        actions={
          <Badge tone={STATUS_TONE[venue.status]}>
            {t(`manage.status.${venue.status}` as MessageKey)}
          </Badge>
        }
      />
      {venue.status === 'PENDING' && (
        <Alert tone="info" className="mb-4">
          {t('manage.status.pendingInfo')}
        </Alert>
      )}
      {(venue.status === 'REJECTED' || venue.status === 'SUSPENDED') && (
        <Alert tone="error" className="mb-4">
          {t(`manage.status.${venue.status}` as MessageKey)}
        </Alert>
      )}
      <nav aria-label={venue.name} className="-mx-1 mb-5 flex gap-1 overflow-x-auto px-1 pb-1">
        {TABS.filter((tab) => can(tab.min)).map((tab) => (
          <NavLink
            key={tab.path}
            to={tab.path}
            className={({ isActive }) =>
              cx(
                'min-h-10 shrink-0 rounded-lg px-3 py-2 text-sm font-medium',
                isActive ? 'bg-brand-700 text-white' : 'text-muted hover:bg-brand-50',
              )
            }
          >
            {t(tab.label)}
          </NavLink>
        ))}
      </nav>
      <Outlet context={ctx} />
    </>
  );
}
