import { VENUE_MAX_PHOTOS, updateVenueSchema, type UploadedImage } from '@footfive/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { ImageUpload } from '../../components/ImageUpload';
import { useToast } from '../../components/Toast';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Field,
  Input,
  Section,
  Textarea,
} from '../../components/ui';
import { useI18n } from '../../i18n';
import { api } from '../../lib/api';
import { type FieldErrors, parseForm, serverFieldErrors } from '../../lib/forms';
import { useVenue } from './VenueManageLayout';

export function InfoTab() {
  const { venue, venueId, reload } = useVenue();
  const { t, tError } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    name: venue.name,
    city: venue.city,
    district: venue.district ?? '',
    address: venue.address,
    phone: venue.phone ?? '',
    description: venue.description ?? '',
    amenities: venue.amenities.join(', '),
    freeUntil: String(venue.cancellationPolicy?.freeUntilHoursBefore ?? 24),
    refundDeposit: venue.cancellationPolicy?.refundDeposit ?? false,
  });
  const [errors, setErrors] = useState<FieldErrors>({});

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['venue'] });
    void queryClient.invalidateQueries({ queryKey: ['manage', 'venues'] });
    reload();
  };
  const save = useMutation({
    mutationFn: (body: unknown) => api(`/manage/venues/${venueId}`, { method: 'PATCH', body }),
    onSuccess: () => {
      toast.success(t('common.saved'));
      refresh();
    },
    onError: (e) => {
      setErrors(serverFieldErrors(e));
      toast.error(tError(e));
    },
  });
  const removePhoto = useMutation({
    mutationFn: (url: string) =>
      api(`/manage/venues/${venueId}/photos/${url.split('/').pop()}`, { method: 'DELETE' }),
    onSuccess: refresh,
    onError: (e) => toast.error(tError(e)),
  });

  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [k]: v }));
  const err = (k: string) => (errors[k] ? t('form.invalidField') : null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const parsed = parseForm(updateVenueSchema, {
      name: form.name,
      city: form.city,
      address: form.address,
      district: form.district.trim() || null,
      phone: form.phone.trim() || null,
      description: form.description.trim() || null,
      amenities: form.amenities
        .split(',')
        .map((a) => a.trim())
        .filter(Boolean),
      cancellationPolicy: {
        freeUntilHoursBefore: Number(form.freeUntil),
        refundDeposit: form.refundDeposit,
      },
    });
    setErrors(parsed.errors ?? {});
    if (parsed.data) save.mutate(parsed.data);
  };

  return (
    <>
      <Card>
        <form onSubmit={submit} noValidate className="space-y-4">
          {save.isError && <Alert tone="error">{tError(save.error)}</Alert>}
          <Field label={t('manage.field.name')} error={err('name')}>
            {(p) => (
              <Input
                {...p}
                maxLength={100}
                value={form.name}
                onChange={(e) => set('name', e.target.value)}
              />
            )}
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('common.city')} error={err('city')}>
              {(p) => (
                <Input {...p} value={form.city} onChange={(e) => set('city', e.target.value)} />
              )}
            </Field>
            <Field label={t('manage.field.district')} optional>
              {(p) => (
                <Input
                  {...p}
                  value={form.district}
                  onChange={(e) => set('district', e.target.value)}
                />
              )}
            </Field>
          </div>
          <Field label={t('manage.field.address')} error={err('address')}>
            {(p) => (
              <Input {...p} value={form.address} onChange={(e) => set('address', e.target.value)} />
            )}
          </Field>
          <Field label={t('manage.field.phone')} optional error={err('phone')}>
            {(p) => (
              <Input
                {...p}
                type="tel"
                value={form.phone}
                onChange={(e) => set('phone', e.target.value)}
              />
            )}
          </Field>
          <Field
            label={t('manage.field.amenities')}
            hint={t('manage.field.amenitiesHint')}
            optional
          >
            {(p) => (
              <Input
                {...p}
                value={form.amenities}
                onChange={(e) => set('amenities', e.target.value)}
              />
            )}
          </Field>
          <Field label={t('common.description')} optional>
            {(p) => (
              <Textarea
                {...p}
                maxLength={2000}
                value={form.description}
                onChange={(e) => set('description', e.target.value)}
              />
            )}
          </Field>
          <fieldset className="space-y-3 rounded-xl border border-line p-4">
            <legend className="px-1 text-sm font-semibold">{t('manage.info.cancellation')}</legend>
            <Field
              label={t('manage.info.freeUntil')}
              error={err('cancellationPolicy.freeUntilHoursBefore')}
            >
              {(p) => (
                <Input
                  {...p}
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={720}
                  value={form.freeUntil}
                  onChange={(e) => set('freeUntil', e.target.value)}
                />
              )}
            </Field>
            <Checkbox
              label={t('manage.info.refundDeposit')}
              checked={form.refundDeposit}
              onChange={(e) => set('refundDeposit', e.target.checked)}
            />
          </fieldset>
          <Button type="submit" loading={save.isPending}>
            {t('common.save')}
          </Button>
        </form>
      </Card>

      <Section title={`${t('manage.info.photos')} (${venue.photos.length}/${VENUE_MAX_PHOTOS})`}>
        <Card>
          <ul className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {venue.photos.map((src) => (
              <li key={src} className="space-y-1.5">
                <img
                  src={src}
                  alt=""
                  loading="lazy"
                  className="aspect-video w-full rounded-xl object-cover"
                />
                <Button
                  variant="ghost"
                  className="min-h-9 w-full text-red-600"
                  loading={removePhoto.isPending && removePhoto.variables === src}
                  onClick={() => removePhoto.mutate(src)}
                >
                  {t('common.remove')}
                </Button>
              </li>
            ))}
          </ul>
          {venue.photos.length < VENUE_MAX_PHOTOS && (
            <ImageUpload
              method="POST"
              path={`/manage/venues/${venueId}/photos`}
              label={t('manage.info.addPhoto')}
              onUploaded={(_: UploadedImage) => refresh()}
            />
          )}
        </Card>
      </Section>
    </>
  );
}
