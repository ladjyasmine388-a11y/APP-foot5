import type { SoloSessionView } from '@footfive/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { PinIcon } from '../../components/icons';
import { useToast } from '../../components/Toast';
import { Alert, Avatar, Badge, Button, Card, EmptyState, ErrorState, LinkButton, Loading, Modal, PageHeader, Section } from '../../components/ui';
import { type MessageKey, useI18n } from '../../i18n';
import { ApiError, api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useNow } from '../../lib/hooks';

export function SoloDetailPage() {
  const { id = '' } = useParams();
  const { t, tError, dateTime, time, money } = useI18n();
  const { status: auth } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [cancelOpen, setCancelOpen] = useState(false);
  const now = useNow();

  const query = useQuery({ queryKey: ['solo', id, auth], queryFn: () => api<SoloSessionView>(`/solo-sessions/${id}`) });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['solo'] });
    void queryClient.invalidateQueries({ queryKey: ['matches'] });
  };
  const join = useMutation({ mutationFn: () => api<SoloSessionView>(`/solo-sessions/${id}/join`, { method: 'POST' }), onSuccess: () => { toast.success(t('solo.joined')); refresh(); }, onError: (e) => { toast.error(tError(e)); refresh(); } });
  const leave = useMutation({ mutationFn: () => api(`/solo-sessions/${id}/leave`, { method: 'POST' }), onSuccess: refresh, onError: (e) => toast.error(tError(e)) });
  const cancel = useMutation({
    mutationFn: () => api(`/solo-sessions/${id}`, { method: 'DELETE' }),
    onSuccess: () => { setCancelOpen(false); refresh(); navigate('/solo'); },
    onError: (e) => toast.error(tError(e)),
  });

  if (query.isPending) return <Loading />;
  if (query.isError) {
    return query.error instanceof ApiError && query.error.status === 404 ? <EmptyState title={t('page.notFound.title')} action={<LinkButton to="/solo">{t('solo.title')}</LinkButton>} /> : <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  }
  const s = query.data;
  const closed = s.status === 'CANCELLED' || s.status === 'COMPLETED' || new Date(s.startsAt).getTime() <= now;
  const canJoin = !closed && !s.joined && !s.isHost && s.remaining > 0;

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title={s.venue.name} subtitle={dateTime(s.startsAt) + ' – ' + time(s.endsAt)} actions={<Badge tone={s.status === 'OPEN' ? 'green' : s.status === 'CANCELLED' ? 'red' : 'neutral'}>{t(`solo.status.${s.status}` as MessageKey)}</Badge>} />

      <Card>
        <p className="flex items-center gap-1 text-sm text-muted"><PinIcon width={16} height={16} />{s.venue.district ? `${s.venue.district}, ` : ''}{s.venue.city} · {s.field.name}</p>
        <div className="mt-3 flex flex-wrap gap-1.5">
          <Badge tone="amber">{s.remaining === 0 ? t('solo.full') : t('solo.spots', { n: s.remaining, total: s.spots })}</Badge>
          <Badge>{s.level ? t(`level.${s.level}` as MessageKey) : t('level.any')}</Badge>
          {s.pricePerPlayerMinor > 0 && <Badge>{t('common.perPlayerIndicative')} : {money(s.pricePerPlayerMinor)}</Badge>}
        </div>
        <div className="mt-4 flex items-center gap-3">
          <Avatar name={s.host.name} url={s.host.avatarUrl} />
          <span className="text-sm">{t('solo.host', { name: s.host.name })}</span>
        </div>
        {s.description && <p className="mt-3 whitespace-pre-line text-sm">{s.description}</p>}
        <Alert tone="info" className="mt-4">{t('solo.payment.note')}</Alert>
      </Card>

      <div className="mt-4 flex flex-wrap gap-2">
        {auth !== 'auth' && !closed && <LinkButton to={`/login?next=/solo/${id}`}>{t('booking.loginToBook')}</LinkButton>}
        {auth === 'auth' && canJoin && <Button loading={join.isPending} onClick={() => join.mutate()}>{t('solo.join')}</Button>}
        {s.joined && !s.isHost && !closed && <Button variant="secondary" loading={leave.isPending} onClick={() => leave.mutate()}>{t('solo.leave')}</Button>}
        {s.isHost && !closed && <Button variant="danger" onClick={() => setCancelOpen(true)}>{t('solo.cancel')}</Button>}
        {s.isHost && <Alert tone="success">{t('solo.isHost')}</Alert>}
        {s.matchId && s.joined && <Link className="self-center text-sm text-brand-700 underline" to={`/matches/${s.matchId}`}>{t('matches.openSession')}</Link>}
      </div>

      <Section title={`${t('solo.players')} (${s.joinedCount})`}>
        {s.players === null ? (
          <p className="text-sm text-muted">{t('solo.players.loginOnly')}</p>
        ) : s.players.length === 0 ? (
          <p className="text-sm text-muted">{t('solo.noPlayers')}</p>
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2">
            {s.players.map((p) => (
              <li key={p.id} className="flex items-center gap-3 rounded-xl border border-line bg-white p-2.5">
                <Avatar name={p.name} url={p.avatarUrl} size={36} />
                <span className="text-sm font-medium">{p.name}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Modal open={cancelOpen} onClose={() => setCancelOpen(false)} title={t('solo.cancel')} footer={<><Button variant="secondary" onClick={() => setCancelOpen(false)}>{t('common.cancel')}</Button><Button variant="danger" loading={cancel.isPending} onClick={() => cancel.mutate()}>{t('solo.cancel')}</Button></>}>
        <p className="text-sm">{t('solo.cancel.confirm')}</p>
      </Modal>
    </div>
  );
}
