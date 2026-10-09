import { VENUE_SORTS, type VenueSearchResponse } from '@footfive/shared';
import { useInfiniteQuery } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { useSearchParams } from 'react-router';
import {
  Button,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Loading,
  PageHeader,
  Select,
  Skeleton,
} from '../../components/ui';
import { VenueCard } from '../../components/venue';
import { type MessageKey, useI18n } from '../../i18n';
import { localDate } from '../../i18n/format';
import { api } from '../../lib/api';

const FILTERS = [
  'city',
  'q',
  'date',
  'time',
  'window',
  'players',
  'priceMax',
  'sort',
  'amenities',
] as const;
const KNOWN_AMENITIES = ['parking', 'vestiaires', 'douches', 'buvette', 'toilettes', 'wifi'];

export function VenuesListPage() {
  const { t, number } = useI18n();
  const [params, setParams] = useSearchParams();
  const applied = Object.fromEntries(FILTERS.map((k) => [k, params.get(k) ?? '']));
  const [draft, setDraft] = useState(applied);

  const query = useInfiniteQuery({
    queryKey: ['venues', 'search', applied],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api<VenueSearchResponse>('/venues', {
        auth: false,
        // `time` n'a de sens qu'avec une date ; le serveur refuse l'inverse.
        query: {
          ...applied,
          time: applied['date'] ? applied['time'] : '',
          cursor: pageParam,
          limit: 12,
        },
      }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const apply = (e: FormEvent) => {
    e.preventDefault();
    const next = new URLSearchParams();
    for (const [key, value] of Object.entries(draft)) if (value) next.set(key, value);
    setParams(next);
  };
  const reset = () => {
    setDraft(Object.fromEntries(FILTERS.map((k) => [k, ''])));
    setParams(new URLSearchParams());
  };
  const set = (key: (typeof FILTERS)[number], value: string) =>
    setDraft((d) => ({ ...d, [key]: value }));
  const selectedAmenities = new Set((draft['amenities'] ?? '').split(',').filter(Boolean));
  const toggleAmenity = (a: string) => {
    const next = new Set(selectedAmenities);
    if (next.has(a)) next.delete(a);
    else next.add(a);
    set('amenities', [...next].join(','));
  };

  const total = query.data?.pages[0]?.total ?? 0;
  const items = query.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <>
      <PageHeader
        title={t('venues.title')}
        subtitle={query.data ? t('venues.count', { n: number(total, 0) }) : undefined}
      />

      <form
        onSubmit={apply}
        className="mb-6 rounded-(--radius-card) border border-line bg-surface p-4"
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label={t('common.city')}>
            {(p) => (
              <Input {...p} value={draft['city']} onChange={(e) => set('city', e.target.value)} />
            )}
          </Field>
          <Field label={t('common.date')}>
            {(p) => (
              <Input
                {...p}
                type="date"
                min={localDate(0)}
                value={draft['date']}
                onChange={(e) => set('date', e.target.value)}
              />
            )}
          </Field>
          <Field label={t('common.time')}>
            {(p) => (
              <Input
                {...p}
                type="time"
                step={3600}
                disabled={!draft['date']}
                value={draft['time']}
                onChange={(e) => set('time', e.target.value)}
              />
            )}
          </Field>
          <Field label={t('venues.search.players')}>
            {(p) => (
              <Input
                {...p}
                type="number"
                inputMode="numeric"
                min={2}
                max={16}
                value={draft['players']}
                onChange={(e) => set('players', e.target.value)}
              />
            )}
          </Field>
        </div>
        <details className="mt-3">
          <summary className="cursor-pointer text-sm font-medium text-brand-700">
            {t('common.filters')}
          </summary>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label={t('venues.search.q')}>
              {(p) => (
                <Input {...p} value={draft['q']} onChange={(e) => set('q', e.target.value)} />
              )}
            </Field>
            <Field label={t('venues.search.priceMax')}>
              {(p) => (
                <Input
                  {...p}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  value={draft['priceMax']}
                  onChange={(e) => set('priceMax', e.target.value)}
                />
              )}
            </Field>
            <Field label={t('venues.search.window')}>
              {(p) => (
                <Select
                  {...p}
                  disabled={!draft['date']}
                  value={draft['window']}
                  onChange={(e) => set('window', e.target.value)}
                >
                  <option value="">{t('venues.search.anyTime')}</option>
                  {[60, 120, 180].map((m) => (
                    <option key={m} value={m}>
                      ± {m / 60} h
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label={t('venues.search.sort')}>
              {(p) => (
                <Select {...p} value={draft['sort']} onChange={(e) => set('sort', e.target.value)}>
                  <option value="">{t('venues.sort.relevance')}</option>
                  {VENUE_SORTS.filter((s) => s !== 'relevance' && s !== 'distance').map((s) => (
                    <option key={s} value={s}>
                      {t(`venues.sort.${s}` as MessageKey)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
          <fieldset className="mt-3">
            <legend className="mb-1.5 text-sm font-medium">{t('venues.search.amenities')}</legend>
            <div className="flex flex-wrap gap-2">
              {KNOWN_AMENITIES.map((a) => (
                <button
                  key={a}
                  type="button"
                  aria-pressed={selectedAmenities.has(a)}
                  onClick={() => toggleAmenity(a)}
                  className={`min-h-9 rounded-full border px-3 text-sm ${selectedAmenities.has(a) ? 'border-brand-700 bg-brand-700 text-white' : 'border-line bg-white'}`}
                >
                  {t(`amenity.${a}` as MessageKey)}
                </button>
              ))}
            </div>
          </fieldset>
        </details>
        <div className="mt-4 flex gap-2">
          <Button type="submit">{t('common.search')}</Button>
          <Button type="button" variant="ghost" onClick={reset}>
            {t('common.reset')}
          </Button>
        </div>
      </form>

      {query.isPending ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-64" />
          ))}
        </div>
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState
          title={t('venues.noResults.title')}
          text={t('venues.noResults.text')}
          action={
            <Button variant="secondary" onClick={reset}>
              {t('common.reset')}
            </Button>
          }
        />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {items.map((v) => (
              <VenueCard key={v.id} venue={v} date={applied['date'] || undefined} />
            ))}
          </div>
          {query.hasNextPage && (
            <div className="mt-6 flex justify-center">
              {query.isFetchingNextPage ? (
                <Loading />
              ) : (
                <Button variant="secondary" onClick={() => void query.fetchNextPage()}>
                  {t('common.loadMore')}
                </Button>
              )}
            </div>
          )}
        </>
      )}
    </>
  );
}
