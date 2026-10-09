import { createReviewSchema, type CancelBookingResponse, type BookingView, type PaymentView, type ReviewView } from '@footfive/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useToast } from '../../components/Toast';
import { Alert, Button, Card, EmptyState, ErrorState, Field, LinkButton, Loading, Modal, PageHeader, Textarea } from '../../components/ui';
import { StarPicker, formatCountdown, useCountdown } from '../../components/venue';
import { useI18n } from '../../i18n';
import { ApiError, api, newIdempotencyKey } from '../../lib/api';
import { useNow } from '../../lib/hooks';
import { BookingStatusBadge } from './BookingBits';

export function BookingDetailPage() {
  const { id = '' } = useParams();
  const { t, tError, dateTime, time, money, date } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [cancelOpen, setCancelOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [reviewOpen, setReviewOpen] = useState(false);
  const [review, setReview] = useState({ rating: 5, comment: '' });

  const now = useNow();
  const booking = useQuery({ queryKey: ['booking', id], queryFn: () => api<BookingView>(`/bookings/${id}`) });
  const left = useCountdown(booking.data?.status === 'PENDING_PAYMENT' ? booking.data.holdExpiresAt : null, () => void booking.refetch());
  const myReview = useQuery({
    queryKey: ['booking', id, 'review'],
    queryFn: () => api<ReviewView>(`/bookings/${id}/review`),
    enabled: booking.data?.status === 'COMPLETED',
    retry: false,
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['booking', id] });
    void queryClient.invalidateQueries({ queryKey: ['bookings'] });
  };

  const pay = useMutation({
    mutationFn: () => api<PaymentView>(`/bookings/${id}/pay`, { method: 'POST', body: {}, idempotencyKey: newIdempotencyKey() }),
    onSuccess: (payment) => payment.checkoutUrl && window.location.assign(payment.checkoutUrl),
    onError: (e) => toast.error(tError(e)),
  });
  const cancel = useMutation({
    mutationFn: () => api<CancelBookingResponse>(`/bookings/${id}/cancel`, { method: 'POST', body: reason.trim() ? { reason: reason.trim() } : {} }),
    onSuccess: (res) => {
      setCancelOpen(false);
      toast.success(res.refund.amountMinor > 0 ? t('bookings.cancelled.refund', { amount: money(res.refund.amountMinor) }) : t('bookings.cancelled.noRefund'));
      refresh();
    },
    onError: (e) => toast.error(tError(e)),
  });
  const sendReview = useMutation({
    mutationFn: () => {
      const parsed = createReviewSchema.parse({ rating: review.rating, ...(review.comment.trim() ? { comment: review.comment.trim() } : {}) });
      return api<ReviewView>(`/bookings/${id}/review`, { method: 'POST', body: parsed });
    },
    onSuccess: () => {
      setReviewOpen(false);
      toast.success(t('review.thanks'));
      void queryClient.invalidateQueries({ queryKey: ['booking', id, 'review'] });
    },
    onError: (e) => toast.error(tError(e)),
  });

  if (booking.isPending) return <Loading />;
  if (booking.isError) {
    return booking.error instanceof ApiError && booking.error.status === 404 ? <EmptyState title={t('page.notFound.title')} action={<LinkButton to="/bookings">{t('bookings.title')}</LinkButton>} /> : <ErrorState error={booking.error} onRetry={() => void booking.refetch()} />;
  }
  const b = booking.data;
  const future = new Date(b.startsAt).getTime() > now;
  const canCancel = (b.status === 'CONFIRMED' || b.status === 'PENDING_PAYMENT') && future;

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title={b.venue.name} subtitle={`${t('booking.reference')} : ${b.reference}`} actions={<BookingStatusBadge status={b.status} />} />

      {b.status === 'PENDING_PAYMENT' && (
        <Alert tone="warning" className="mb-4 space-y-2">
          <p>{left !== null && left > 0 ? t('booking.holdLeft', { time: formatCountdown(left) }) : t('booking.status.EXPIRED')}</p>
          {left !== null && left > 0 && <Button loading={pay.isPending} onClick={() => pay.mutate()}>{t('booking.continuePayment')}</Button>}
        </Alert>
      )}

      <Card>
        <dl className="space-y-2 text-sm">
          <Line label={t('booking.pitch')} value={`${b.field.name} · ${b.venue.address}, ${b.venue.city}`} />
          <Line label={t('common.date')} value={date(b.startsAt)} />
          <Line label={t('common.time')} value={`${time(b.startsAt)} – ${time(b.endsAt)}`} />
          <Line label={t('booking.price')} value={money(b.priceMinor)} />
          <Line label={t('booking.total')} value={money(b.totalMinor)} strong />
          <Line label={t('booking.paid')} value={money(b.paidOnlineMinor)} />
          <Line label={t('booking.dueOnSite')} value={money(Math.max(0, b.totalMinor - b.paidOnlineMinor))} />
        </dl>
        {b.cancellationReason && <p className="mt-3 text-sm text-muted">{t('common.reason')} : {b.cancellationReason}</p>}
        {b.venue.phone && <a href={`tel:${b.venue.phone}`} dir="ltr" className="num mt-3 inline-block text-sm font-medium text-brand-700">{t('bookings.contactVenue')} · {b.venue.phone}</a>}
      </Card>

      {b.status === 'CONFIRMED' && future && (
        <Card className="mt-4">
          <h2 className="mb-2 font-semibold">{t('bookings.useFor')}</h2>
          <div className="flex flex-wrap gap-2">
            <LinkButton variant="secondary" to={`/solo/new?booking=${b.id}`}>{t('nav.solo')}</LinkButton>
            <LinkButton variant="secondary" to={`/opponents/new?booking=${b.id}`}>{t('nav.opponents')}</LinkButton>
            <LinkButton variant="secondary" to={`/matches/new?booking=${b.id}`}>{t('matches.newTeamMatch')}</LinkButton>
          </div>
        </Card>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        {canCancel && <Button variant="danger" onClick={() => setCancelOpen(true)}>{t('bookings.cancel')}</Button>}
        {b.status === 'COMPLETED' && (myReview.data ? <Alert tone="success">{t('review.thanks')}</Alert> : <Button onClick={() => setReviewOpen(true)}>{t('review.give')}</Button>)}
        <LinkButton variant="ghost" to={`/venues/${b.venue.slug}`}>{b.venue.name}</LinkButton>
        <Link className="self-center text-sm text-brand-700 underline" to="/bookings">{t('bookings.title')}</Link>
      </div>

      <Modal
        open={cancelOpen}
        onClose={() => setCancelOpen(false)}
        title={t('bookings.cancel.title')}
        footer={
          <>
            <Button variant="secondary" onClick={() => setCancelOpen(false)}>{t('bookings.cancel.keep')}</Button>
            <Button variant="danger" loading={cancel.isPending} onClick={() => cancel.mutate()}>{t('bookings.cancel')}</Button>
          </>
        }
      >
        {b.cancellation.refundable && b.cancellation.freeUntil ? (
          <Alert tone="success">{t('bookings.cancel.free', { date: dateTime(b.cancellation.freeUntil) })}</Alert>
        ) : (
          b.paidOnlineMinor > 0 && <Alert tone="warning">{t('bookings.cancel.late')}</Alert>
        )}
        <Field label={t('bookings.cancel.reason')}>{(p) => <Textarea {...p} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
      </Modal>

      <Modal
        open={reviewOpen}
        onClose={() => setReviewOpen(false)}
        title={t('review.title')}
        footer={
          <>
            <Button variant="secondary" onClick={() => setReviewOpen(false)}>{t('common.cancel')}</Button>
            <Button loading={sendReview.isPending} onClick={() => sendReview.mutate()}>{t('common.confirm')}</Button>
          </>
        }
      >
        <StarPicker value={review.rating} onChange={(rating) => setReview({ ...review, rating })} label={t('review.rating')} />
        <Field label={t('review.comment')} optional>{(p) => <Textarea {...p} maxLength={1000} value={review.comment} onChange={(e) => setReview({ ...review, comment: e.target.value })} />}</Field>
      </Modal>
    </div>
  );
}

function Line({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`flex justify-between gap-4 ${strong ? 'border-t border-line pt-2 font-semibold' : ''}`}>
      <dt className="text-muted">{label}</dt>
      <dd className="num text-end">{value}</dd>
    </div>
  );
}
