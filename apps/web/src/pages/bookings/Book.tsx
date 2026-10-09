import { ONLINE_PAYMENT_MODES, type BookingQuote, type BookingView, type PaymentView } from '@footfive/shared';
import { useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { Alert, Button, Card, ErrorState, Loading, PageHeader } from '../../components/ui';
import { type MessageKey, useI18n } from '../../i18n';
import { ApiError, api, newIdempotencyKey } from '../../lib/api';
import { useAuth } from '../../lib/auth';

export function BookPage() {
  const { fieldId = '' } = useParams();
  const [params] = useSearchParams();
  const startsAt = params.get('start') ?? '';
  const venueSlug = params.get('venue');
  const { t, tError, money, dateTime, time } = useI18n();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [mode, setMode] = useState<(typeof ONLINE_PAYMENT_MODES)[number]>('DEPOSIT');
  const [failure, setFailure] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  // Une même intention garde la même clé : si le réseau coupe pendant l'envoi, le réessai ne crée jamais une seconde réservation.
  const keys = useRef({ booking: newIdempotencyKey(), pay: newIdempotencyKey() });

  const quote = useQuery({
    queryKey: ['quote', fieldId, startsAt, mode],
    queryFn: () => api<BookingQuote>('/bookings/quote', { method: 'POST', body: { fieldId, startsAt, paymentMode: mode } }),
    enabled: Boolean(fieldId && startsAt) && user?.emailVerified === true,
    retry: false,
  });

  const confirm = async () => {
    setBusy(true);
    setFailure(null);
    try {
      const booking = await api<BookingView>('/bookings', { method: 'POST', body: { fieldId, startsAt, paymentMode: mode }, idempotencyKey: keys.current.booking });
      try {
        const payment = await api<PaymentView>(`/bookings/${booking.id}/pay`, { method: 'POST', body: {}, idempotencyKey: keys.current.pay });
        if (payment.checkoutUrl) {
          window.location.assign(payment.checkoutUrl); // page de paiement du prestataire
          return;
        }
      } catch {
        /* la réservation existe et son créneau est gardé : la page de détail permet de relancer le paiement */
      }
      navigate(`/bookings/${booking.id}`, { replace: true });
    } catch (error) {
      setFailure(error);
      if (!(error instanceof ApiError && error.code === 'NETWORK')) keys.current = { booking: newIdempotencyKey(), pay: newIdempotencyKey() };
    } finally {
      setBusy(false);
    }
  };

  if (!startsAt) return <Alert tone="error">{tError(new ApiError(400, 'VALIDATION_ERROR', ''))}</Alert>;
  const q = quote.data;

  return (
    <div className="mx-auto max-w-xl">
      <PageHeader title={t('booking.title')} />
      {user && !user.emailVerified && <Alert tone="warning" className="mb-4">{t('booking.verifyToBook')}</Alert>}
      {quote.isPending && user?.emailVerified && <Loading />}
      {quote.isError && (
        <div className="space-y-3">
          <ErrorState error={quote.error} />
          {venueSlug && <Link className="font-semibold text-brand-700 underline" to={`/venues/${venueSlug}`}>{t('common.back')}</Link>}
        </div>
      )}
      {q && (
        <Card>
          <h2 className="mb-3 font-semibold">{t('booking.summary')}</h2>
          <dl className="space-y-2 text-sm">
            <Row label={t('booking.pitch')} value={`${q.venueName} · ${q.fieldName}`} />
            <Row label={t('booking.slot')} value={`${dateTime(q.startsAt)} – ${time(q.endsAt)}`} />
            <Row label={t('booking.price')} value={money(q.priceMinor)} />
            {q.feesMinor > 0 && <Row label={t('booking.fees')} value={money(q.feesMinor)} />}
            {q.taxMinor > 0 && <Row label={t('booking.tax')} value={money(q.taxMinor)} />}
            <Row label={t('booking.total')} value={money(q.totalMinor)} strong />
          </dl>

          <fieldset className="mt-5">
            <legend className="mb-2 text-sm font-medium">{t('booking.mode')}</legend>
            <div className="space-y-2">
              {ONLINE_PAYMENT_MODES.map((m) => (
                <label key={m} className={`flex min-h-12 cursor-pointer items-center gap-3 rounded-xl border px-3 py-2 text-sm ${mode === m ? 'border-brand-600 bg-brand-50' : 'border-line'}`}>
                  <input type="radio" name="mode" className="size-4 accent-brand-700" checked={mode === m} onChange={() => setMode(m)} />
                  {t(`booking.mode.${m}` as MessageKey)}
                </label>
              ))}
            </div>
          </fieldset>

          <div className="mt-4 rounded-xl bg-brand-50 p-3 text-sm">
            <p className="flex justify-between font-semibold text-brand-900"><span>{t('booking.dueOnline')}</span><span className="num">{money(q.dueOnlineMinor)}</span></p>
            <p className="mt-1 flex justify-between text-muted"><span>{t('booking.dueOnSite')}</span><span className="num">{money(q.dueOnSiteMinor)}</span></p>
          </div>
          <p className="mt-3 text-xs text-muted">{t('booking.holdInfo', { n: q.holdMinutes })}</p>

          {failure !== null && <Alert tone="error" className="mt-4">{tError(failure)}</Alert>}
          <Button className="mt-4 w-full" loading={busy} onClick={() => void confirm()}>
            {t('booking.payAndConfirm', { amount: money(q.dueOnlineMinor) })}
          </Button>
        </Card>
      )}
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`flex justify-between gap-4 ${strong ? 'border-t border-line pt-2 font-semibold' : ''}`}>
      <dt className="text-muted">{label}</dt>
      <dd className="num text-end">{value}</dd>
    </div>
  );
}
