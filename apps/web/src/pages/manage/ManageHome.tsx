import {
  createVenueSchema,
  type ManageVenueDetail,
  type ManageVenueSummary,
} from '@footfive/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useToast } from '../../components/Toast';
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Input,
  LinkButton,
  Loading,
  PageHeader,
  Textarea,
} from '../../components/ui';
import { type MessageKey, useI18n } from '../../i18n';
import { api } from '../../lib/api';
import { type FieldErrors, blankToUndefined, parseForm, serverFieldErrors } from '../../lib/forms';

export const STATUS_TONE = {
  APPROVED: 'green',
  PENDING: 'amber',
  SUSPENDED: 'red',
  REJECTED: 'red',
} as const;

export function ManageHomePage() {
  const { t } = useI18n();
  const venues = useQuery({
    queryKey: ['manage', 'venues'],
    queryFn: () => api<ManageVenueSummary[]>('/manage/venues'),
  });
  return (
    <>
      <PageHeader
        title={t('manage.title')}
        actions={<LinkButton to="/manage/venues/new">{t('manage.declare')}</LinkButton>}
      />
      {venues.isPending ? (
        <Loading />
      ) : venues.isError ? (
        <ErrorState error={venues.error} onRetry={() => void venues.refetch()} />
      ) : venues.data.length === 0 ? (
        <EmptyState
          title={t('manage.empty.title')}
          text={t('manage.empty.text')}
          action={<LinkButton to="/manage/venues/new">{t('manage.declare')}</LinkButton>}
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {venues.data.map((v) => (
            <Link key={v.id} to={`/manage/venues/${v.id}`} className="block">
              <Card className="h-full transition-shadow hover:shadow-md">
                <div className="flex items-start justify-between gap-2">
                  <h2 className="font-semibold">{v.name}</h2>
                  <Badge tone={STATUS_TONE[v.status]}>
                    {t(`manage.status.${v.status}` as MessageKey)}
                  </Badge>
                </div>
                <p className="mt-1 text-sm text-muted">
                  {v.city} · {t('venues.fields', { n: v.fieldsCount })}
                </p>
                <p className="mt-2 text-xs text-muted">
                  {t(`manage.role.${v.role}` as MessageKey)}
                </p>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}

export function VenueCreatePage() {
  const { t, tError } = useI18n();
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    name: '',
    city: '',
    district: '',
    address: '',
    phone: '',
    description: '',
    amenities: '',
  });
  const [errors, setErrors] = useState<FieldErrors>({});

  const create = useMutation({
    mutationFn: (body: unknown) =>
      api<ManageVenueDetail>('/manage/venues', { method: 'POST', body }),
    onSuccess: (venue) => {
      toast.success(t('manage.create.done'));
      void queryClient.invalidateQueries({ queryKey: ['manage', 'venues'] });
      navigate(`/manage/venues/${venue.id}/fields`, { replace: true });
    },
    onError: (e) => setErrors(serverFieldErrors(e)),
  });
  const set = <K extends keyof typeof form>(key: K, value: string) =>
    setForm((f) => ({ ...f, [key]: value }));
  const err = (key: string) => (errors[key] ? t('form.invalidField') : null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const parsed = parseForm(createVenueSchema, {
      name: form.name,
      city: form.city,
      address: form.address,
      district: blankToUndefined(form.district),
      phone: blankToUndefined(form.phone),
      description: blankToUndefined(form.description),
      amenities: form.amenities
        .split(',')
        .map((a) => a.trim())
        .filter(Boolean),
    });
    setErrors(parsed.errors ?? {});
    if (parsed.data) create.mutate(parsed.data);
  };

  return (
    <div className="mx-auto max-w-xl">
      <PageHeader title={t('manage.create.title')} subtitle={t('manage.create.text')} />
      <Card>
        <form onSubmit={submit} noValidate className="space-y-4">
          {create.isError && <Alert tone="error">{tError(create.error)}</Alert>}
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
              <Input
                {...p}
                autoComplete="street-address"
                value={form.address}
                onChange={(e) => set('address', e.target.value)}
              />
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
          <Button type="submit" loading={create.isPending} className="w-full">
            {t('common.create')}
          </Button>
        </form>
      </Card>
    </div>
  );
}
