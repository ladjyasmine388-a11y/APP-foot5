import { PLAYER_LEVELS, createSoloSessionSchema, type SoloSessionView } from '@footfive/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useToast } from '../../components/Toast';
import { Alert, Button, Card, ErrorState, Field, Input, LinkButton, Loading, PageHeader, Select, Textarea } from '../../components/ui';
import { type MessageKey, useI18n } from '../../i18n';
import { api } from '../../lib/api';
import { type FieldErrors, parseForm, serverFieldErrors } from '../../lib/forms';
import { useBookableBookings } from '../../lib/hooks';

export function SoloNewPage() {
  const { t, tError, dateTime } = useI18n();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const bookings = useBookableBookings();
  const [form, setForm] = useState({ bookingId: params.get('booking') ?? '', spots: '3', level: '', price: '', description: '' });
  const [errors, setErrors] = useState<FieldErrors>({});

  const create = useMutation({
    mutationFn: (body: unknown) => api<SoloSessionView>('/solo-sessions', { method: 'POST', body }),
    onSuccess: (session) => {
      toast.success(t('solo.new.created'));
      void queryClient.invalidateQueries({ queryKey: ['solo'] });
      void queryClient.invalidateQueries({ queryKey: ['bookings'] });
      navigate(`/solo/${session.id}`, { replace: true });
    },
    onError: (e) => setErrors(serverFieldErrors(e)),
  });

  const chosen = bookings.data?.find((b) => b.id === form.bookingId);
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((f) => ({ ...f, [key]: value }));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const parsed = parseForm(createSoloSessionSchema, {
      bookingId: form.bookingId,
      spots: Number(form.spots),
      ...(form.level ? { level: form.level } : {}),
      ...(form.price.trim() ? { pricePerPlayerMinor: Number(form.price) } : {}),
      ...(form.description.trim() ? { description: form.description.trim() } : {}),
    });
    setErrors(parsed.errors ?? {});
    if (parsed.data) create.mutate(parsed.data);
  };

  if (bookings.isPending) return <Loading />;
  if (bookings.isError) return <ErrorState error={bookings.error} onRetry={() => void bookings.refetch()} />;

  return (
    <div className="mx-auto max-w-xl">
      <PageHeader title={t('solo.new.title')} />
      {bookings.data.length === 0 ? (
        <Alert tone="info" className="space-y-3">
          <p>{t('solo.new.noBooking')}</p>
          <LinkButton to="/venues">{t('home.search.cta')}</LinkButton>
        </Alert>
      ) : (
        <Card>
          <form onSubmit={submit} noValidate className="space-y-4">
            {create.isError && <Alert tone="error">{tError(create.error)}</Alert>}
            <Field label={t('solo.new.booking')} error={errors['bookingId'] ? t('form.required') : null}>
              {(p) => (
                <Select {...p} value={form.bookingId} onChange={(e) => set('bookingId', e.target.value)}>
                  <option value="">—</option>
                  {bookings.data.map((b) => <option key={b.id} value={b.id}>{b.venue.name} · {b.field.name} · {dateTime(b.startsAt)}</option>)}
                </Select>
              )}
            </Field>
            <Field label={t('solo.new.spots')} hint={chosen ? t('solo.new.spotsHint') : undefined} error={errors['spots'] ? t('form.invalidField') : null}>
              {(p) => <Input {...p} type="number" inputMode="numeric" min={1} max={15} value={form.spots} onChange={(e) => set('spots', e.target.value)} />}
            </Field>
            <Field label={t('common.level')} optional>
              {(p) => (
                <Select {...p} value={form.level} onChange={(e) => set('level', e.target.value)}>
                  <option value="">{t('level.any')}</option>
                  {PLAYER_LEVELS.map((l) => <option key={l} value={l}>{t(`level.${l}` as MessageKey)}</option>)}
                </Select>
              )}
            </Field>
            <Field label={t('solo.new.price')} optional error={errors['pricePerPlayerMinor'] ? t('form.invalidField') : null}>
              {(p) => <Input {...p} type="number" inputMode="numeric" min={0} value={form.price} onChange={(e) => set('price', e.target.value)} />}
            </Field>
            <Field label={t('solo.new.description')} optional error={errors['description'] ? t('form.invalidField') : null}>
              {(p) => <Textarea {...p} maxLength={300} value={form.description} onChange={(e) => set('description', e.target.value)} />}
            </Field>
            <Alert tone="info">{t('solo.payment.note')}</Alert>
            <Button type="submit" loading={create.isPending} className="w-full">{t('solo.open')}</Button>
          </form>
        </Card>
      )}
    </div>
  );
}
