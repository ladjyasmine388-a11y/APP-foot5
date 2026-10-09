import type { DayAvailability, FieldDayAvailability, PublicSlot, ReviewPage, VenueDetail } from '@footfive/shared';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { PinIcon } from '../../components/icons';
import { Badge, Button, Card, EmptyState, ErrorState, Loading, Section, Skeleton, cx } from '../../components/ui';
import { AmenityChips, DateStrip, Stars, VenuePhoto } from '../../components/venue';
import { type MessageKey, useI18n } from '../../i18n';
import { localDate } from '../../i18n/format';
import { ApiError, api } from '../../lib/api';

function SlotGrid({ field, onPick }: { field: FieldDayAvailability; onPick: (slot: PublicSlot, field: FieldDayAvailability) => void }) {
  const { t, time, money } = useI18n();
  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">{field.name}</h3>
        <Badge>{t('venue.capacity', { n: field.capacity })}</Badge>
      </div>
      {field.slots.length === 0 ? (
        <p className="text-sm text-muted">{t('venue.noSlots')}</p>
      ) : (
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {field.slots.map((slot) => {
            const free = slot.status === 'AVAILABLE';
            return (
              <li key={slot.startsAt}>
                <button
                  type="button"
                  disabled={!free}
                  onClick={() => onPick(slot, field)}
                  aria-label={`${time(slot.startsAt)} – ${time(slot.endsAt)}, ${t(`venue.slot.${slot.status}` as MessageKey)}`}
                  className={cx('flex min-h-14 w-full flex-col items-center justify-center rounded-xl border px-2 py-1.5 text-sm', free ? 'border-brand-300 bg-brand-50 text-brand-900 hover:bg-brand-100' : 'cursor-not-allowed border-line bg-canvas text-muted line-through decoration-1')}
                >
                  <span className="num font-semibold">{time(slot.startsAt)}</span>
                  <span className="num text-xs">{free && slot.priceMinor !== null ? money(slot.priceMinor) : t(`venue.slot.${slot.status}` as MessageKey)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

function Reviews({ slug }: { slug: string }) {
  const { t, date } = useI18n();
  const query = useInfiniteQuery({
    queryKey: ['venue', slug, 'reviews'],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api<ReviewPage>(`/venues/${slug}/reviews`, { auth: false, query: { cursor: pageParam, limit: 5 } }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = query.data?.pages.flatMap((p) => p.items) ?? [];
  if (query.isPending) return <Skeleton className="h-24" />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  if (items.length === 0) return <p className="text-sm text-muted">{t('venue.reviews.empty')}</p>;
  return (
    <div className="space-y-3">
      {items.map((r) => (
        <Card key={r.id} className="p-4">
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium">{r.author}</span>
            <span className="text-xs text-muted">{date(r.createdAt)}</span>
          </div>
          <Stars value={r.rating} />
          {/* Texte brut : jamais interprété comme du HTML */}
          {r.comment && <p className="mt-1 whitespace-pre-line text-sm text-ink">{r.comment}</p>}
        </Card>
      ))}
      {query.hasNextPage && <Button variant="secondary" loading={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>{t('common.loadMore')}</Button>}
    </div>
  );
}

export function VenueDetailPage() {
  const { slug = '' } = useParams();
  const { t, time, number } = useI18n();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const today = localDate(0);
  const picked = params.get('date');
  const date = picked && picked >= today ? picked : today;

  const venue = useQuery({ queryKey: ['venue', slug], queryFn: () => api<VenueDetail>(`/venues/${slug}`, { auth: false }) });
  const availability = useQuery({
    queryKey: ['venue', slug, 'availability', date],
    queryFn: () => api<DayAvailability>(`/venues/${slug}/availability`, { auth: false, query: { date } }),
    enabled: venue.isSuccess,
  });

  if (venue.isPending) return <Loading />;
  if (venue.isError) {
    return venue.error instanceof ApiError && venue.error.status === 404 ? (
      <EmptyState title={t('venue.notFound')} action={<Link className="font-semibold text-brand-700 underline" to="/venues">{t('venues.title')}</Link>} />
    ) : (
      <ErrorState error={venue.error} onRetry={() => void venue.refetch()} />
    );
  }
  const v = venue.data;

  const pick = (slot: PublicSlot, field: FieldDayAvailability) => navigate(`/book/${field.fieldId}?start=${encodeURIComponent(slot.startsAt)}&venue=${encodeURIComponent(v.slug)}`);

  return (
    <>
      <div className="-mx-4 -mt-5 sm:mx-0 sm:mt-0">
        <VenuePhoto src={v.photos[0] ?? v.photo} alt={v.name} className="h-48 w-full sm:h-72 sm:rounded-3xl" />
      </div>
      {v.photos.length > 1 && (
        <ul className="mt-2 flex gap-2 overflow-x-auto">
          {v.photos.slice(1).map((src) => (
            <li key={src}><img src={src} alt="" loading="lazy" className="h-20 w-28 rounded-xl object-cover" /></li>
          ))}
        </ul>
      )}

      <div className="mt-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold sm:text-3xl">{v.name}</h1>
          <p className="mt-1 flex items-center gap-1 text-sm text-muted"><PinIcon width={16} height={16} />{v.address}, {v.city}</p>
        </div>
        <div className="text-end">
          <Stars value={v.ratingAvg} count={v.ratingCount} />
          {v.phone && <a href={`tel:${v.phone}`} dir="ltr" className="num mt-1 block text-sm font-medium text-brand-700">{t('venue.call')} {v.phone}</a>}
        </div>
      </div>
      <div className="mt-3"><AmenityChips amenities={v.amenities} /></div>
      {v.description && <p className="mt-4 max-w-3xl whitespace-pre-line text-sm text-ink">{v.description}</p>}

      <Section title={t('venue.availability')}>
        <DateStrip value={date} onChange={(d) => setParams({ date: d }, { replace: true })} />
        <p className="mb-3 text-sm text-muted">{t('venue.legend')}</p>
        {availability.isPending ? (
          <Skeleton className="h-40" />
        ) : availability.isError ? (
          <ErrorState error={availability.error} onRetry={() => void availability.refetch()} />
        ) : availability.data.fields.length === 0 ? (
          <EmptyState title={t('venue.noSlots')} />
        ) : (
          <div className="space-y-3">{availability.data.fields.map((f) => <SlotGrid key={f.fieldId} field={f} onPick={pick} />)}</div>
        )}
      </Section>

      <Section title={t('nav.venues')}>
        <div className="grid gap-3 sm:grid-cols-2">
          {v.fields.map((f) => (
            <Card key={f.id} className="p-4">
              <div className="flex items-start justify-between gap-2">
                <h3 className="font-semibold">{f.name}</h3>
                {f.priceFromMinor !== null && <span className="num text-sm font-semibold text-brand-800">{t('venues.fromPrice', { price: number(f.priceFromMinor, 0) + ' DA' })}</span>}
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Badge tone="green">{t('venue.capacity', { n: f.capacity })}</Badge>
                <Badge>{t(`surface.${f.surface}` as MessageKey)}</Badge>
                {f.lighting && <Badge>{t('field.lighting')}</Badge>}
                {f.covered && <Badge>{t('field.covered')}</Badge>}
                {f.dimensions && <Badge>{f.dimensions}</Badge>}
              </div>
              {f.description && <p className="mt-2 text-sm text-muted">{f.description}</p>}
            </Card>
          ))}
        </div>
      </Section>

      <Section title={t('venue.hours')}>
        <Card className="p-4">
          <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
            {[1, 2, 3, 4, 5, 6, 7].map((day) => {
              const entry = v.openingHours.find((h) => h.weekday === day);
              return (
                <div key={day} className="flex justify-between gap-3 border-b border-line/60 py-1.5">
                  <dt className="font-medium">{t(`weekday.${day}` as MessageKey)}</dt>
                  <dd className="num text-muted" dir="ltr">
                    {entry && entry.intervals.length > 0 ? entry.intervals.map((i) => `${i.from}–${i.to}`).join(', ') : t('venue.closed')}
                  </dd>
                </div>
              );
            })}
          </dl>
          <p className="mt-2 text-xs text-muted">{time(new Date())} · {v.timezone}</p>
        </Card>
      </Section>

      <Section title={t('venue.reviews')}>
        <Reviews slug={v.slug} />
      </Section>
    </>
  );
}
