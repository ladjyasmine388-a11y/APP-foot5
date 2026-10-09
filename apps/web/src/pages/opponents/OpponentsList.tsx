import { PLAYER_LEVELS, type OpponentListingView, type PageOf } from '@footfive/shared';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { Button, EmptyState, ErrorState, Field, Input, LinkButton, Loading, PageHeader, Section, Select, Skeleton } from '../../components/ui';
import { type MessageKey, useI18n } from '../../i18n';
import { localDate } from '../../i18n/format';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { OpponentCard } from './OpponentBits';

const KEYS = ['city', 'date', 'level', 'playersPerSide'] as const;

export function OpponentsListPage() {
  const { t } = useI18n();
  const { status } = useAuth();
  const [params, setParams] = useSearchParams();
  const [filtersOpen, setFiltersOpen] = useState(false);
  const f = Object.fromEntries(KEYS.map((k) => [k, params.get(k) ?? ''])) as Record<(typeof KEYS)[number], string>;
  const set = (key: (typeof KEYS)[number], value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const query = useInfiniteQuery({
    queryKey: ['opponents', 'list', f, status],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api<PageOf<OpponentListingView>>('/opponent-listings', { query: { ...f, cursor: pageParam, limit: 12 } }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const mine = useQuery({ queryKey: ['opponents', 'mine'], queryFn: () => api<OpponentListingView[]>('/me/opponent-listings'), enabled: status === 'auth' });
  const items = query.data?.pages.flatMap((p) => p.items) ?? [];
  const myOpen = (mine.data ?? []).filter((l) => l.status === 'OPEN' || l.status === 'ACCEPTED').slice(0, 6);

  return (
    <>
      <PageHeader title={t('opp.title')} subtitle={t('opp.subtitle')} actions={<LinkButton to="/opponents/new">{t('opp.publish')}</LinkButton>} />
      {myOpen.length > 0 && (
        <Section title={t('opp.mine')}>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">{myOpen.map((l) => <OpponentCard key={l.id} listing={l} />)}</div>
        </Section>
      )}
      <Button variant="secondary" className="mb-3 sm:hidden" aria-expanded={filtersOpen} onClick={() => setFiltersOpen((o) => !o)}>{t('common.filters')}</Button>
      <div className={`mb-5 gap-3 rounded-(--radius-card) border border-line bg-surface p-4 sm:grid-cols-2 lg:grid-cols-4 ${filtersOpen ? 'grid' : 'hidden'} sm:grid`}>
        <Field label={t('common.city')}>{(p) => <Input {...p} value={f.city} onChange={(e) => set('city', e.target.value)} />}</Field>
        <Field label={t('common.date')}>{(p) => <Input {...p} type="date" min={localDate(0)} value={f.date} onChange={(e) => set('date', e.target.value)} />}</Field>
        <Field label={t('common.level')}>
          {(p) => (
            <Select {...p} value={f.level} onChange={(e) => set('level', e.target.value)}>
              <option value="">{t('level.any')}</option>
              {PLAYER_LEVELS.map((l) => <option key={l} value={l}>{t(`level.${l}` as MessageKey)}</option>)}
            </Select>
          )}
        </Field>
        <Field label={t('opp.new.perSide')}>
          {(p) => (
            <Select {...p} value={f.playersPerSide} onChange={(e) => set('playersPerSide', e.target.value)}>
              <option value="">{t('common.all')}</option>
              {[5, 6, 7, 8].map((n) => <option key={n} value={n}>{t('opp.perSide', { n })}</option>)}
            </Select>
          )}
        </Field>
      </div>
      {query.isPending ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-44" />)}</div>
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState title={t('opp.empty.title')} text={t('opp.empty.text')} action={<LinkButton to="/opponents/new">{t('opp.publish')}</LinkButton>} />
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">{items.map((l) => <OpponentCard key={l.id} listing={l} />)}</div>
          {query.hasNextPage && <div className="mt-6 flex justify-center">{query.isFetchingNextPage ? <Loading /> : <Button variant="secondary" onClick={() => void query.fetchNextPage()}>{t('common.loadMore')}</Button>}</div>}
        </>
      )}
    </>
  );
}
