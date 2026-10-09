import type { BookingStatus, BookingView } from '@footfive/shared';
import { Link } from 'react-router';
import { Badge, Card } from '../../components/ui';
import { type MessageKey, useI18n } from '../../i18n';

const TONES: Record<BookingStatus, 'green' | 'amber' | 'red' | 'neutral' | 'blue'> = {
  CONFIRMED: 'green',
  PENDING_PAYMENT: 'amber',
  CANCELLED: 'red',
  EXPIRED: 'neutral',
  COMPLETED: 'blue',
  NO_SHOW: 'red',
};

export function BookingStatusBadge({ status }: { status: BookingStatus }) {
  const { t } = useI18n();
  return <Badge tone={TONES[status]}>{t(`booking.status.${status}` as MessageKey)}</Badge>;
}

export function BookingCard({ booking }: { booking: BookingView }) {
  const { dateTime, time, money, t } = useI18n();
  return (
    <Link to={`/bookings/${booking.id}`} className="block">
      <Card className="transition-shadow hover:shadow-md">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <p className="font-semibold">{booking.venue.name}</p>
            <p className="text-sm text-muted">
              {booking.field.name} · {booking.venue.city}
            </p>
          </div>
          <BookingStatusBadge status={booking.status} />
        </div>
        <p className="num mt-2 text-sm">
          {dateTime(booking.startsAt)} – {time(booking.endsAt)}
        </p>
        <div className="mt-2 flex justify-between text-sm text-muted">
          <span className="num">
            {t('booking.reference')} : {booking.reference}
          </span>
          <span className="num font-medium text-ink">{money(booking.totalMinor)}</span>
        </div>
      </Card>
    </Link>
  );
}
