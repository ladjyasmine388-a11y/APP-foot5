import type { VenueCard as VenueCardData } from '@footfive/shared';
import { useEffect, useRef } from 'react';
import { Link } from 'react-router';
import { useI18n } from '../i18n';
import { localDate } from '../i18n/format';
import { useNow } from '../lib/hooks';
import { PinIcon, StarIcon } from './icons';
import { Badge, cx } from './ui';

export function Stars({
  value,
  count,
  size = 16,
}: {
  value: number;
  count?: number;
  size?: number;
}) {
  const { t, number } = useI18n();
  if (count === 0) return <span className="text-xs text-muted">{t('venues.rating.none')}</span>;
  return (
    <span
      className="inline-flex items-center gap-1 text-sm"
      aria-label={t('review.stars', { n: number(value) })}
    >
      <StarIcon width={size} height={size} className="fill-amber-400 text-amber-500" />
      <span className="num font-semibold">{number(value)}</span>
      {count !== undefined && <span className="text-xs text-muted">({count})</span>}
    </span>
  );
}

/** Sélecteur de note 1 à 5 accessible (groupe de boutons radio). */
export function StarPicker({
  value,
  onChange,
  label,
}: {
  value: number;
  onChange: (n: number) => void;
  label: string;
}) {
  const { t } = useI18n();
  return (
    <div role="radiogroup" aria-label={label} className="flex gap-1">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={value === n}
          aria-label={t('review.stars', { n })}
          onClick={() => onChange(n)}
          className="inline-flex size-11 items-center justify-center rounded-lg hover:bg-amber-50"
        >
          <StarIcon
            width={28}
            height={28}
            className={n <= value ? 'fill-amber-400 text-amber-500' : 'text-line'}
          />
        </button>
      ))}
    </div>
  );
}

export function AmenityChips({ amenities, max }: { amenities: string[]; max?: number }) {
  const { tMaybe } = useI18n();
  const shown = max ? amenities.slice(0, max) : amenities;
  return (
    <ul className="flex flex-wrap gap-1.5">
      {shown.map((a) => (
        <li key={a}>
          <Badge>{tMaybe(`amenity.${a}`) ?? a}</Badge>
        </li>
      ))}
      {max && amenities.length > max && (
        <li>
          <Badge>+{amenities.length - max}</Badge>
        </li>
      )}
    </ul>
  );
}

/** Image du complexe, ou un dégradé aux couleurs du site quand le gérant n'a pas encore envoyé de photo. */
export function VenuePhoto({
  src,
  alt = '',
  className,
}: {
  src: string | null | undefined;
  alt?: string;
  className?: string;
}) {
  return src ? (
    <img src={src} alt={alt} loading="lazy" className={cx('object-cover', className)} />
  ) : (
    <div
      aria-hidden="true"
      className={cx('bg-linear-to-br from-brand-700 to-brand-500', className)}
    />
  );
}

export function VenueCard({ venue, date }: { venue: VenueCardData; date?: string }) {
  const { t, money, time } = useI18n();
  return (
    <Link
      to={`/venues/${venue.slug}${date ? `?date=${date}` : ''}`}
      className="group block overflow-hidden rounded-(--radius-card) border border-line bg-surface shadow-sm transition-shadow hover:shadow-md"
    >
      <VenuePhoto src={venue.photo} className="h-36 w-full" />
      <div className="space-y-2 p-4">
        <div className="flex items-start justify-between gap-2">
          <h3 className="text-base font-semibold text-ink group-hover:text-brand-700">
            {venue.name}
          </h3>
          <Stars value={venue.ratingAvg} count={venue.ratingCount} />
        </div>
        <p className="flex items-center gap-1 text-sm text-muted">
          <PinIcon width={16} height={16} />
          {venue.district ? `${venue.district}, ` : ''}
          {venue.city}
          {venue.distanceKm !== null && <span className="num ms-1">· {venue.distanceKm} km</span>}
        </p>
        <AmenityChips amenities={venue.amenities} max={3} />
        <div className="flex items-center justify-between border-t border-line pt-2 text-sm">
          <span className="text-muted">{t('venues.fields', { n: venue.fieldsCount })}</span>
          {venue.priceFromMinor !== null && (
            <span className="num font-semibold text-brand-800">
              {t('venues.fromPrice', { price: money(venue.priceFromMinor) })}
            </span>
          )}
        </div>
        {venue.matchingSlots !== null && (
          <p className="text-xs font-medium text-brand-700">
            {venue.matchingSlots > 0
              ? `${t('venues.matching', { n: venue.matchingSlots })}${venue.firstMatchingSlotAt ? ` · ${t('venues.firstSlot', { time: time(venue.firstMatchingSlotAt) })}` : ''}`
              : t('venue.slot.UNAVAILABLE')}
          </p>
        )}
      </div>
    </Link>
  );
}

/** Bandeau des 14 prochains jours (à l'heure d'Alger). */
export function DateStrip({
  value,
  onChange,
  days = 14,
}: {
  value: string;
  onChange: (date: string) => void;
  days?: number;
}) {
  const { date: formatDate, t } = useI18n();
  const list = Array.from({ length: days }, (_, i) => localDate(i));
  return (
    <div
      role="listbox"
      aria-label={t('venue.chooseDate')}
      className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-2"
    >
      {list.map((d, i) => {
        const selected = d === value;
        const label =
          i === 0
            ? t('common.today')
            : i === 1
              ? t('common.tomorrow')
              : formatDate(`${d}T12:00:00Z`);
        return (
          <button
            key={d}
            type="button"
            role="option"
            aria-selected={selected}
            onClick={() => onChange(d)}
            className={cx(
              'min-h-14 min-w-24 shrink-0 rounded-xl border px-3 py-2 text-center text-sm',
              selected
                ? 'border-brand-700 bg-brand-700 font-semibold text-white'
                : 'border-line bg-white hover:bg-brand-50',
            )}
          >
            <span className="block text-xs opacity-80">{i < 2 ? label : label.split(' ')[0]}</span>
            <span className="num block font-semibold">
              {d.slice(8, 10)}/{d.slice(5, 7)}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Compte à rebours jusqu'à `until` (verrou de paiement). Appelle `onExpire` une seule fois à l'échéance. */
export function useCountdown(
  until: string | null | undefined,
  onExpire?: () => void,
): number | null {
  const target = until ? new Date(until).getTime() : null;
  const now = useNow(1000, target !== null);
  const left = target === null ? null : Math.max(0, target - now);
  const fired = useRef(false);
  useEffect(() => {
    if (left === 0 && !fired.current) {
      fired.current = true;
      onExpire?.();
    }
    if (left !== 0) fired.current = false;
  }, [left, onExpire]);
  return left;
}

export const formatCountdown = (ms: number): string => {
  const total = Math.ceil(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};
