import type { BookingListResponse } from '@footfive/shared';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import {
  Button,
  EmptyState,
  ErrorState,
  LinkButton,
  Loading,
  PageHeader,
  Skeleton,
  cx,
} from '../../components/ui';
import { useI18n } from '../../i18n';
import { api } from '../../lib/api';
import { BookingCard } from './BookingBits';

const TABS = ['upcoming', 'past', 'all'] as const;

export function BookingsListPage() {
  const { t } = useI18n();
  const [params, setParams] = useSearchParams();
  const when = (TABS as readonly string[]).includes(params.get('when') ?? '')
    ? (params.get('when') as (typeof TABS)[number])
    : 'upcoming';

  const query = useInfiniteQuery({
    queryKey: ['bookings', when],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api<BookingListResponse>('/bookings', { query: { when, cursor: pageParam, limit: 10 } }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = query.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <>
      <PageHeader
        title={t('bookings.title')}
        actions={<LinkButton to="/venues">{t('home.search.cta')}</LinkButton>}
      />
      <div role="tablist" className="mb-4 inline-flex rounded-xl border border-line bg-white p-1">
        {TABS.map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={when === tab}
            onClick={() => setParams({ when: tab }, { replace: true })}
            className={cx(
              'min-h-10 rounded-lg px-4 text-sm font-medium',
              when === tab ? 'bg-brand-700 text-white' : 'text-muted',
            )}
          >
            {tab === 'upcoming'
              ? t('common.upcoming')
              : tab === 'past'
                ? t('common.past')
                : t('common.all')}
          </button>
        ))}
      </div>
      {query.isPending ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState
          title={t('bookings.empty.title')}
          text={t('bookings.empty.text')}
          action={<LinkButton to="/venues">{t('home.search.cta')}</LinkButton>}
        />
      ) : (
        <div className="space-y-3">
          {items.map((b) => (
            <BookingCard key={b.id} booking={b} />
          ))}
          {query.hasNextPage &&
            (query.isFetchingNextPage ? (
              <Loading />
            ) : (
              <Button variant="secondary" onClick={() => void query.fetchNextPage()}>
                {t('common.loadMore')}
              </Button>
            ))}
        </div>
      )}
    </>
  );
}
