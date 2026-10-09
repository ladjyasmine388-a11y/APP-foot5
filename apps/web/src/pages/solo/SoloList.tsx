import { PLAYER_LEVELS, SOLO_SORTS, type PageOf, type SoloSessionView } from '@footfive/shared';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { Button, EmptyState, ErrorState, Field, Input, LinkButton, Loading, PageHeader, Section, Select, Skeleton } from '../../components/ui';
import { type MessageKey, useI18n } from '../../i18n';
import { localDate } from '../../i18n/format';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { SoloCard } from './SoloCard';

const KEYS = ['city', 'date', 'time', 'level', 'spots', 'sort'] as const;

export function SoloListPage() {
  const { t } = useI18n();
  const { status } = useAuth();
  const [params, setParams] = useSearchParams();
  const [filtersOpen, setFiltersOpen] = useState(false);
  const f = Object.fromEntries(KEYS.map((k) => [k, params.get(k) ?? ''])) as Record<(typeof KEYS)[number], string>;
  const set = (key: (typeof KEYS)[number], value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key === 'date' && !value) next.delete('time'); // l'heure n'a de sens qu'avec une date
    setParams(next, { replace: true });
  };

  const query = useInfiniteQuery({
    // « Pour moi » dépend du compte : la clé inclut l'état de connexion pour ne jamais mélanger les listes.
    queryKey: ['solo', 'list', f, status],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api<PageOf<SoloSessionView>>('/solo-sessions', { query: { ...f, sort: f.sort === 'recommended' && status !== 'auth' ? '' : f.sort, cursor: pageParam, limit: 12 } }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = query.data?.pages.flatMap((p) => p.items) ?? [];
  const mine = useQuery({ queryKey: ['solo', 'mine'], queryFn: () => api<PageOf<SoloSessionView>>('/me/solo-sessions', { query: { when: 'upcoming', limit: 6 } }), enabled: status === 'auth' });

  return (
    <>
      <PageHeader
        title={t('solo.title')}
        subtitle={t('solo.subtitle')}
        actions={<LinkButton to="/solo/new">{t('solo.open')}</LinkButton>}
      />
      {mine.data && mine.data.items.length > 0 && (
        <Section title={t('solo.mine')}>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">{mine.data.items.map((s) => <SoloCard key={s.id} session={s} />)}</div>
        </Section>
      )}
      <Button variant="secondary" className="mb-3 sm:hidden" aria-expanded={filtersOpen} onClick={() => setFiltersOpen((o) => !o)}>{t('common.filters')}</Button>
      <div className={`mb-5 gap-3 rounded-(--radius-card) border border-line bg-surface p-4 sm:grid-cols-2 lg:grid-cols-6 ${filtersOpen ? 'grid' : 'hidden'} sm:grid`}>
        <Field label={t('common.city')}>{(p) => <Input {...p} value={f.city} onChange={(e) => set('city', e.target.value)} />}</Field>
        <Field label={t('common.date')}>{(p) => <Input {...p} type="date" min={localDate(0)} value={f.date} onChange={(e) => set('date', e.target.value)} />}</Field>
        <Field label={t('common.time')}>{(p) => <Input {...p} type="time" step={3600} disabled={!f.date} value={f.time} onChange={(e) => set('time', e.target.value)} />}</Field>
        <Field label={t('common.level')}>
          {(p) => (
            <Select {...p} value={f.level} onChange={(e) => set('level', e.target.value)}>
              <option value="">{t('level.any')}</option>
              {PLAYER_LEVELS.map((l) => <option key={l} value={l}>{t(`level.${l}` as MessageKey)}</option>)}
            </Select>
          )}
        </Field>
        <Field label={t('solo.minSpots')}>{(p) => <Input {...p} type="number" inputMode="numeric" min={1} max={15} value={f.spots} onChange={(e) => set('spots', e.target.value)} />}</Field>
        <Field label={t('venues.search.sort')}>
          {(p) => (
            <Select {...p} value={f.sort} onChange={(e) => set('sort', e.target.value)}>
              {SOLO_SORTS.filter((s) => s !== 'recommended' || status === 'auth').map((s) => <option key={s} value={s === 'soonest' ? '' : s}>{t(`solo.sort.${s}` as MessageKey)}</option>)}
            </Select>
          )}
        </Field>
      </div>

      {query.isPending ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-36" />)}</div>
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState title={t('solo.empty.title')} text={t('solo.empty.text')} action={<LinkButton to="/solo/new">{t('solo.open')}</LinkButton>} />
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">{items.map((s) => <SoloCard key={s.id} session={s} />)}</div>
          {query.hasNextPage && <div className="mt-6 flex justify-center">{query.isFetchingNextPage ? <Loading /> : <Button variant="secondary" onClick={() => void query.fetchNextPage()}>{t('common.loadMore')}</Button>}</div>}
        </>
      )}
    </>
  );
}
