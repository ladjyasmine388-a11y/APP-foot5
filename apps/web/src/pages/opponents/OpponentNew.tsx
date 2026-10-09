import { PLAYER_LEVELS, createOpponentListingSchema, type OpponentListingView } from '@footfive/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useToast } from '../../components/Toast';
import { Alert, Button, Card, ErrorState, Field, LinkButton, Loading, PageHeader, Select, Textarea } from '../../components/ui';
import { type MessageKey, useI18n } from '../../i18n';
import { api } from '../../lib/api';
import { type FieldErrors, parseForm, serverFieldErrors } from '../../lib/forms';
import { captainOf, useBookableBookings, useMyTeams } from '../../lib/hooks';

export function OpponentNewPage() {
  const { t, tError, dateTime } = useI18n();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const teams = useMyTeams();
  const bookings = useBookableBookings();
  const [form, setForm] = useState({ teamId: '', bookingId: params.get('booking') ?? '', playersPerSide: '', level: '', comment: '' });
  const [errors, setErrors] = useState<FieldErrors>({});

  const create = useMutation({
    mutationFn: (body: unknown) => api<OpponentListingView>('/opponent-listings', { method: 'POST', body }),
    onSuccess: (listing) => {
      toast.success(t('opp.new.created'));
      void queryClient.invalidateQueries({ queryKey: ['opponents'] });
      void queryClient.invalidateQueries({ queryKey: ['bookings'] });
      navigate(`/opponents/${listing.id}`, { replace: true });
    },
    onError: (e) => setErrors(serverFieldErrors(e)),
  });

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((f) => ({ ...f, [key]: value }));
  if (teams.isPending || bookings.isPending) return <Loading />;
  if (teams.isError) return <ErrorState error={teams.error} />;
  if (bookings.isError) return <ErrorState error={bookings.error} />;

  const myCaptainTeams = captainOf(teams.data);
  const teamId = form.teamId || myCaptainTeams[0]?.id || '';

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const parsed = parseForm(createOpponentListingSchema, {
      teamId,
      bookingId: form.bookingId,
      ...(form.playersPerSide ? { playersPerSide: Number(form.playersPerSide) } : {}),
      ...(form.level ? { level: form.level } : {}),
      ...(form.comment.trim() ? { comment: form.comment.trim() } : {}),
    });
    setErrors(parsed.errors ?? {});
    if (parsed.data) create.mutate(parsed.data);
  };

  return (
    <div className="mx-auto max-w-xl">
      <PageHeader title={t('opp.new.title')} />
      {myCaptainTeams.length === 0 ? (
        <Alert tone="info" className="space-y-3"><p>{t('opp.new.noTeam')}</p><LinkButton to="/teams">{t('teams.create')}</LinkButton></Alert>
      ) : bookings.data.length === 0 ? (
        <Alert tone="info" className="space-y-3"><p>{t('solo.new.noBooking')}</p><LinkButton to="/venues">{t('home.search.cta')}</LinkButton></Alert>
      ) : (
        <Card>
          <form onSubmit={submit} noValidate className="space-y-4">
            {create.isError && <Alert tone="error">{tError(create.error)}</Alert>}
            <Field label={t('opp.new.team')}>
              {(p) => <Select {...p} value={teamId} onChange={(e) => set('teamId', e.target.value)}>{myCaptainTeams.map((team) => <option key={team.id} value={team.id}>{team.name} ({t('teams.memberCount', { n: team.memberCount })})</option>)}</Select>}
            </Field>
            <Field label={t('solo.new.booking')} error={errors['bookingId'] ? t('form.required') : null}>
              {(p) => (
                <Select {...p} value={form.bookingId} onChange={(e) => set('bookingId', e.target.value)}>
                  <option value="">—</option>
                  {bookings.data.map((b) => <option key={b.id} value={b.id}>{b.venue.name} · {b.field.name} · {dateTime(b.startsAt)}</option>)}
                </Select>
              )}
            </Field>
            <Field label={t('opp.new.perSide')} optional>
              {(p) => (
                <Select {...p} value={form.playersPerSide} onChange={(e) => set('playersPerSide', e.target.value)}>
                  <option value="">—</option>
                  {[5, 6, 7, 8].map((n) => <option key={n} value={n}>{t('opp.perSide', { n })}</option>)}
                </Select>
              )}
            </Field>
            <Field label={t('common.level')} optional>
              {(p) => (
                <Select {...p} value={form.level} onChange={(e) => set('level', e.target.value)}>
                  <option value="">—</option>
                  {PLAYER_LEVELS.map((l) => <option key={l} value={l}>{t(`level.${l}` as MessageKey)}</option>)}
                </Select>
              )}
            </Field>
            <Field label={t('opp.new.comment')} optional>{(p) => <Textarea {...p} maxLength={300} value={form.comment} onChange={(e) => set('comment', e.target.value)} />}</Field>
            <Button type="submit" loading={create.isPending} className="w-full">{t('opp.publish')}</Button>
          </form>
        </Card>
      )}
    </div>
  );
}
