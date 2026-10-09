import { createBlockSchema, createManualBookingSchema, type ManageBookingView } from '@footfive/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { useToast } from '../../components/Toast';
import { Alert, Badge, Button, Card, EmptyState, ErrorState, Field, Input, Loading, Modal, Select, Textarea } from '../../components/ui';
import { type MessageKey, useI18n } from '../../i18n';
import { localDate, localToUtcIso } from '../../i18n/format';
import { api } from '../../lib/api';
import { type FieldErrors, blankToUndefined, parseForm, serverFieldErrors } from '../../lib/forms';
import { BookingStatusBadge } from '../bookings/BookingBits';
import { useVenue } from './VenueManageLayout';

type Dialog = { kind: 'manual' } | { kind: 'block' } | { kind: 'cancel'; booking: ManageBookingView } | null;

export function BookingsTab() {
  const { venue, venueId, can } = useVenue();
  const { t, tError, time, date, money } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [range, setRange] = useState({ from: localDate(0), to: localDate(6) });
  const [fieldId, setFieldId] = useState('');
  const [dialog, setDialog] = useState<Dialog>(null);
  const [form, setForm] = useState({ fieldId: venue.fields[0]?.id ?? '', date: localDate(1), start: '20:00', end: '21:00', customerName: '', customerPhone: '', note: '', price: '', reason: '' });
  const [errors, setErrors] = useState<FieldErrors>({});

  const key = ['manage', venueId, 'bookings', range, fieldId];
  const list = useQuery({ queryKey: key, queryFn: () => api<ManageBookingView[]>(`/manage/venues/${venueId}/bookings`, { query: { ...range, fieldId, includeBlocks: 'true' } }) });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['manage', venueId] });
    void queryClient.invalidateQueries({ queryKey: ['venue'] });
  };
  const set = <K extends keyof typeof form>(k: K, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const close = () => { setDialog(null); setErrors({}); };

  const createManual = useMutation({
    mutationFn: (body: unknown) => api(`/manage/venues/${venueId}/bookings`, { method: 'POST', body }),
    onSuccess: () => { close(); toast.success(t('manage.bookings.created')); refresh(); },
    onError: (e) => { setErrors(serverFieldErrors(e)); toast.error(tError(e)); },
  });
  const createBlock = useMutation({
    mutationFn: (body: unknown) => api(`/manage/venues/${venueId}/blocks`, { method: 'POST', body }),
    onSuccess: () => { close(); toast.success(t('manage.bookings.blockCreated')); refresh(); },
    onError: (e) => { setErrors(serverFieldErrors(e)); toast.error(tError(e)); },
  });
  const cancel = useMutation({
    mutationFn: (b: ManageBookingView) => api(`/manage/venues/${venueId}/bookings/${b.id}/cancel`, { method: 'POST', body: { reason: form.reason.trim() } }),
    onSuccess: () => { close(); toast.success(t('manage.bookings.cancelled')); refresh(); },
    onError: (e) => toast.error(tError(e)),
  });
  const noShow = useMutation({
    mutationFn: (id: string) => api(`/manage/venues/${venueId}/bookings/${id}/no-show`, { method: 'POST' }),
    onSuccess: () => { toast.success(t('manage.bookings.noShow.done')); refresh(); },
    onError: (e) => toast.error(tError(e)),
  });
  const unblock = useMutation({
    mutationFn: (id: string) => api(`/manage/venues/${venueId}/blocks/${id}`, { method: 'DELETE' }),
    onSuccess: refresh,
    onError: (e) => toast.error(tError(e)),
  });

  const submitManual = (e: FormEvent) => {
    e.preventDefault();
    const parsed = parseForm(createManualBookingSchema, {
      fieldId: form.fieldId,
      startsAt: localToUtcIso(form.date, form.start, venue.timezone),
      customerName: form.customerName,
      customerPhone: blankToUndefined(form.customerPhone),
      note: blankToUndefined(form.note),
      ...(form.price.trim() ? { priceMinor: Number(form.price) } : {}),
    });
    setErrors(parsed.errors ?? {});
    if (parsed.data) createManual.mutate(parsed.data);
  };
  const submitBlock = (e: FormEvent) => {
    e.preventDefault();
    const parsed = parseForm(createBlockSchema, {
      fieldId: form.fieldId,
      startsAt: localToUtcIso(form.date, form.start, venue.timezone),
      endsAt: localToUtcIso(form.date, form.end, venue.timezone),
      reason: blankToUndefined(form.reason),
    });
    setErrors(parsed.errors ?? {});
    if (parsed.data) createBlock.mutate(parsed.data);
  };

  const days = new Map<string, ManageBookingView[]>();
  for (const b of list.data ?? []) {
    const day = localDate(0, new Date(b.startsAt));
    days.set(day, [...(days.get(day) ?? []), b]);
  }
  const fieldSelect = (
    <Field label={t('manage.bookings.field')}>{(p) => <Select {...p} value={form.fieldId} onChange={(e) => set('fieldId', e.target.value)}>{venue.fields.filter((f) => f.isActive).map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</Select>}</Field>
  );

  return (
    <>
      <div className="mb-4 grid gap-3 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end">
        <Field label={t('common.from')}>{(p) => <Input {...p} type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} />}</Field>
        <Field label={t('common.to')}>{(p) => <Input {...p} type="date" min={range.from} value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} />}</Field>
        <Field label={t('manage.bookings.field')}>{(p) => <Select {...p} value={fieldId} onChange={(e) => setFieldId(e.target.value)}><option value="">{t('common.all')}</option>{venue.fields.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</Select>}</Field>
        <div className="flex gap-2">
          <Button onClick={() => { setForm((f) => ({ ...f, customerName: '', customerPhone: '', note: '', price: '', reason: '' })); setDialog({ kind: 'manual' }); }}>{t('manage.bookings.manual')}</Button>
          {can('MANAGER') && <Button variant="secondary" onClick={() => setDialog({ kind: 'block' })}>{t('manage.bookings.block')}</Button>}
        </div>
      </div>

      {list.isPending ? <Loading /> : list.isError ? <ErrorState error={list.error} onRetry={() => void list.refetch()} /> : list.data.length === 0 ? <EmptyState title={t('manage.bookings.empty')} /> : (
        [...days.entries()].map(([day, items]) => (
          <section key={day} className="mb-5">
            <h2 className="mb-2 text-sm font-semibold capitalize text-muted">{date(`${day}T12:00:00Z`)}</h2>
            <ul className="space-y-2">
              {items.map((b) => {
                const isBlock = b.bookingType === 'BLOCK';
                const active = b.status === 'CONFIRMED' || b.status === 'PENDING_PAYMENT';
                const started = new Date(b.startsAt).getTime() <= Date.now();
                return (
                  <li key={b.id}>
                    <Card className="p-3 sm:p-4">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div>
                          <p className="num font-semibold">{time(b.startsAt)} – {time(b.endsAt)} <span className="font-normal text-muted">· {b.field.name}</span></p>
                          {isBlock ? <p className="text-sm text-muted">{t('manage.bookings.blocked')}{b.note ? ` — ${b.note}` : ''}</p> : (
                            <p className="text-sm">{b.customer?.name ?? '—'} {b.customer?.phone && <a dir="ltr" className="num ms-2 text-brand-700" href={`tel:${b.customer.phone}`}>{b.customer.phone}</a>}</p>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          {isBlock ? <Badge>{t('manage.bookings.blocked')}</Badge> : <BookingStatusBadge status={b.status} />}
                        </div>
                      </div>
                      {!isBlock && (
                        <p className="num mt-2 text-xs text-muted">
                          {b.reference} · {t(`manage.bookings.source.${b.source}` as MessageKey)} · {money(b.priceMinor)}
                          {can('MANAGER') && b.commissionMinor > 0 && ` · ${t('manage.bookings.commission')} ${money(b.commissionMinor)} · ${t('manage.bookings.venueShare')} ${money(b.venueAmountMinor)}`}
                          {b.dueOnSiteMinor > 0 && ` · ${t('booking.dueOnSite')} ${money(b.dueOnSiteMinor)}`}
                        </p>
                      )}
                      {b.cancellationReason && <p className="mt-1 text-xs text-muted">{t('common.reason')} : {b.cancellationReason}</p>}
                      <div className="mt-2 flex flex-wrap gap-2">
                        {isBlock && b.status !== 'CANCELLED' && can('MANAGER') && <Button variant="secondary" className="min-h-9" loading={unblock.isPending && unblock.variables === b.id} onClick={() => unblock.mutate(b.id)}>{t('manage.bookings.removeBlock')}</Button>}
                        {!isBlock && active && !started && <Button variant="danger" className="min-h-9" onClick={() => { set('reason', ''); setDialog({ kind: 'cancel', booking: b }); }}>{t('common.cancel')}</Button>}
                        {!isBlock && b.status === 'CONFIRMED' && started && <Button variant="secondary" className="min-h-9" onClick={() => noShow.mutate(b.id)}>{t('manage.bookings.noShow')}</Button>}
                      </div>
                    </Card>
                  </li>
                );
              })}
            </ul>
          </section>
        ))
      )}

      <Modal open={dialog?.kind === 'manual'} onClose={close} title={t('manage.bookings.manual')} footer={<><Button variant="secondary" onClick={close}>{t('common.cancel')}</Button><Button loading={createManual.isPending} onClick={() => (document.getElementById('manual-form') as HTMLFormElement | null)?.requestSubmit()}>{t('common.save')}</Button></>}>
        <form id="manual-form" onSubmit={submitManual} noValidate className="space-y-3">
          <Alert tone="info">{t('manage.bookings.manual.hint')}</Alert>
          {fieldSelect}
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('common.date')}>{(p) => <Input {...p} type="date" value={form.date} onChange={(e) => set('date', e.target.value)} />}</Field>
            <Field label={t('manage.bookings.start')}>{(p) => <Input {...p} type="time" step={3600} value={form.start} onChange={(e) => set('start', e.target.value)} />}</Field>
          </div>
          <Field label={t('manage.bookings.customer')} error={errors['customerName'] ? t('form.required') : null}>{(p) => <Input {...p} value={form.customerName} onChange={(e) => set('customerName', e.target.value)} />}</Field>
          <Field label={t('manage.bookings.customerPhone')} optional error={errors['customerPhone'] ? t('form.invalidField') : null}>{(p) => <Input {...p} type="tel" value={form.customerPhone} onChange={(e) => set('customerPhone', e.target.value)} />}</Field>
          <Field label={t('manage.bookings.agreedPrice')} optional>{(p) => <Input {...p} type="number" inputMode="numeric" min={0} value={form.price} onChange={(e) => set('price', e.target.value)} />}</Field>
          <Field label={t('manage.bookings.note')} optional>{(p) => <Textarea {...p} maxLength={500} value={form.note} onChange={(e) => set('note', e.target.value)} />}</Field>
        </form>
      </Modal>

      <Modal open={dialog?.kind === 'block'} onClose={close} title={t('manage.bookings.block')} footer={<><Button variant="secondary" onClick={close}>{t('common.cancel')}</Button><Button loading={createBlock.isPending} onClick={() => (document.getElementById('block-form') as HTMLFormElement | null)?.requestSubmit()}>{t('common.save')}</Button></>}>
        <form id="block-form" onSubmit={submitBlock} noValidate className="space-y-3">
          <Alert tone="info">{t('manage.bookings.block.hint')}</Alert>
          {fieldSelect}
          <div className="grid grid-cols-3 gap-3">
            <Field label={t('common.date')}>{(p) => <Input {...p} type="date" value={form.date} onChange={(e) => set('date', e.target.value)} />}</Field>
            <Field label={t('manage.bookings.start')}>{(p) => <Input {...p} type="time" step={3600} value={form.start} onChange={(e) => set('start', e.target.value)} />}</Field>
            <Field label={t('manage.bookings.end')} error={errors['endsAt'] ? t('form.invalidField') : null}>{(p) => <Input {...p} type="time" step={3600} value={form.end} onChange={(e) => set('end', e.target.value)} />}</Field>
          </div>
          <Field label={t('common.reason')} optional>{(p) => <Input {...p} maxLength={300} value={form.reason} onChange={(e) => set('reason', e.target.value)} />}</Field>
        </form>
      </Modal>

      <Modal open={dialog?.kind === 'cancel'} onClose={close} title={t('manage.bookings.cancelReason')} footer={<><Button variant="secondary" onClick={close}>{t('common.back')}</Button><Button variant="danger" disabled={!form.reason.trim()} loading={cancel.isPending} onClick={() => dialog?.kind === 'cancel' && cancel.mutate(dialog.booking)}>{t('common.cancel')}</Button></>}>
        {dialog?.kind === 'cancel' && dialog.booking.paidOnlineMinor > 0 && <Alert tone="warning">{t('manage.bookings.cancel.refund', { amount: money(dialog.booking.paidOnlineMinor) })}</Alert>}
        <Field label={t('common.reason')}>{(p) => <Textarea {...p} maxLength={300} value={form.reason} onChange={(e) => set('reason', e.target.value)} />}</Field>
      </Modal>
    </>
  );
}
