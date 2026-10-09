import type { MatchRequestView, MatchView, OpponentListingView } from '@footfive/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { PinIcon } from '../../components/icons';
import { useToast } from '../../components/Toast';
import { Alert, Avatar, Badge, Button, Card, EmptyState, ErrorState, Field, LinkButton, Loading, Modal, PageHeader, Section, Select, Textarea } from '../../components/ui';
import { type MessageKey, useI18n } from '../../i18n';
import { ApiError, api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { captainOf, useMyTeams, useNow } from '../../lib/hooks';

export function OpponentDetailPage() {
  const { id = '' } = useParams();
  const { t, tError, dateTime, time } = useI18n();
  const { status: auth } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [requestOpen, setRequestOpen] = useState(false);
  const [teamId, setTeamId] = useState('');
  const [message, setMessage] = useState('');
  const [removeOpen, setRemoveOpen] = useState(false);

  const listing = useQuery({ queryKey: ['opponent', id, auth], queryFn: () => api<OpponentListingView>(`/opponent-listings/${id}`) });
  const myTeams = useMyTeams();
  const now = useNow();
  const captainTeams = captainOf(myTeams.data);
  const l = listing.data;
  const isOwner = Boolean(l && captainTeams.some((team) => team.id === l.team.id));
  const requests = useQuery({
    queryKey: ['opponent', id, 'requests'],
    queryFn: () => api<MatchRequestView[]>(`/opponent-listings/${id}/requests`),
    enabled: isOwner,
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['opponent'] });
    void queryClient.invalidateQueries({ queryKey: ['opponents'] });
    void queryClient.invalidateQueries({ queryKey: ['matches'] });
  };
  const request = useMutation({
    mutationFn: () => api<MatchRequestView>(`/opponent-listings/${id}/requests`, { method: 'POST', body: { teamId, ...(message.trim() ? { message: message.trim() } : {}) } }),
    onSuccess: () => { setRequestOpen(false); toast.success(t('opp.request.sent')); refresh(); },
    onError: (e) => toast.error(tError(e)),
  });
  const accept = useMutation({
    mutationFn: (requestId: string) => api<MatchView>(`/opponent-listings/${id}/requests/${requestId}/accept`, { method: 'POST' }),
    onSuccess: (match) => { toast.success(t('opp.accepted')); refresh(); navigate(`/matches/${match.id}`); },
    onError: (e) => { toast.error(tError(e)); refresh(); },
  });
  const reject = useMutation({
    mutationFn: (requestId: string) => api(`/opponent-listings/${id}/requests/${requestId}/reject`, { method: 'POST' }),
    onSuccess: refresh,
    onError: (e) => toast.error(tError(e)),
  });
  const withdraw = useMutation({
    mutationFn: (requestId: string) => api(`/opponent-requests/${requestId}`, { method: 'DELETE' }),
    onSuccess: refresh,
    onError: (e) => toast.error(tError(e)),
  });
  const remove = useMutation({
    mutationFn: () => api(`/opponent-listings/${id}`, { method: 'DELETE' }),
    onSuccess: () => { setRemoveOpen(false); refresh(); navigate('/opponents'); },
    onError: (e) => toast.error(tError(e)),
  });

  if (listing.isPending) return <Loading />;
  if (listing.isError) {
    return listing.error instanceof ApiError && listing.error.status === 404 ? <EmptyState title={t('page.notFound.title')} action={<LinkButton to="/opponents">{t('opp.title')}</LinkButton>} /> : <ErrorState error={listing.error} onRetry={() => void listing.refetch()} />;
  }
  const data = listing.data;
  const open = data.status === 'OPEN' && new Date(data.startsAt).getTime() > now;
  const askingTeams = captainTeams.filter((team) => team.id !== data.team.id);

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title={data.team.name} subtitle={`${dateTime(data.startsAt)} – ${time(data.endsAt)}`} actions={<Badge tone={data.status === 'OPEN' ? 'green' : 'neutral'}>{t(`opp.status.${data.status}` as MessageKey)}</Badge>} />
      <Card>
        <div className="flex items-center gap-3">
          <Avatar name={data.team.name} url={data.team.logoUrl} size={52} />
          <div>
            <Link to={`/teams/${data.team.id}`} className="font-semibold text-brand-700 hover:underline">{data.team.name}</Link>
            <p className="text-sm text-muted">{t('teams.memberCount', { n: data.team.memberCount })} · {t(`level.${data.team.level}` as MessageKey)}</p>
          </div>
        </div>
        <p className="mt-3 flex items-center gap-1 text-sm text-muted"><PinIcon width={16} height={16} />{data.venue.name}, {data.venue.city} · {data.field.name}</p>
        <div className="mt-3 flex flex-wrap gap-1.5">
          <Badge tone="green">{t('opp.perSide', { n: data.playersPerSide })}</Badge>
          <Badge>{data.level ? t(`level.${data.level}` as MessageKey) : t('level.any')}</Badge>
        </div>
        {data.comment && <p className="mt-3 whitespace-pre-line text-sm">{data.comment}</p>}
        {data.matchId && <LinkButton variant="secondary" to={`/matches/${data.matchId}`} className="mt-4">{t('nav.matches')}</LinkButton>}
      </Card>

      <div className="mt-4 flex flex-wrap gap-2">
        {auth !== 'auth' && open && <LinkButton to={`/login?next=/opponents/${id}`}>{t('booking.loginToBook')}</LinkButton>}
        {auth === 'auth' && open && !isOwner && !data.myRequest && askingTeams.length > 0 && <Button onClick={() => { setTeamId(askingTeams[0]?.id ?? ''); setRequestOpen(true); }}>{t('opp.request')}</Button>}
        {auth === 'auth' && open && !isOwner && !data.myRequest && askingTeams.length === 0 && myTeams.isSuccess && <Alert tone="info">{t('opp.new.noTeam')}</Alert>}
        {data.myRequest?.status === 'REQUESTED' && <Button variant="secondary" loading={withdraw.isPending} onClick={() => withdraw.mutate((data.myRequest as { id: string }).id)}>{t('opp.withdrawRequest')}</Button>}
        {data.myRequest && data.myRequest.status !== 'REQUESTED' && <Badge tone="amber">{t('opp.myRequest', { status: t(`opp.request.status.${data.myRequest.status}` as MessageKey) })}</Badge>}
        {isOwner && open && <Button variant="danger" onClick={() => setRemoveOpen(true)}>{t('opp.cancelListing')}</Button>}
      </div>

      {isOwner && (
        <Section title={t('opp.requests')}>
          {requests.isPending ? <Loading /> : requests.isError ? <ErrorState error={requests.error} /> : requests.data.length === 0 ? <p className="text-sm text-muted">{t('opp.requests.none')}</p> : (
            <ul className="space-y-3">
              {requests.data.map((r) => (
                <li key={r.id}>
                  <Card className="p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-3">
                        <Avatar name={r.team.name} url={r.team.logoUrl} />
                        <div>
                          <Link className="font-semibold text-brand-700 hover:underline" to={`/teams/${r.team.id}`}>{r.team.name}</Link>
                          <p className="text-xs text-muted">{t('teams.memberCount', { n: r.team.memberCount })} · {t(`level.${r.team.level}` as MessageKey)}</p>
                        </div>
                      </div>
                      <Badge tone={r.status === 'ACCEPTED' ? 'green' : r.status === 'REQUESTED' ? 'amber' : 'neutral'}>{t(`opp.request.status.${r.status}` as MessageKey)}</Badge>
                    </div>
                    {r.message && <p className="mt-2 text-sm">{r.message}</p>}
                    {r.status === 'REQUESTED' && open && (
                      <div className="mt-3 flex flex-wrap gap-2">
                        <Button loading={accept.isPending && accept.variables === r.id} onClick={() => accept.mutate(r.id)}>{t('opp.accept')}</Button>
                        <Button variant="secondary" onClick={() => reject.mutate(r.id)}>{t('opp.reject')}</Button>
                      </div>
                    )}
                  </Card>
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}

      <Modal open={requestOpen} onClose={() => setRequestOpen(false)} title={t('opp.request')} footer={<><Button variant="secondary" onClick={() => setRequestOpen(false)}>{t('common.cancel')}</Button><Button loading={request.isPending} disabled={!teamId} onClick={() => request.mutate()}>{t('opp.request')}</Button></>}>
        <Field label={t('opp.request.team')}>{(p) => <Select {...p} value={teamId} onChange={(e) => setTeamId(e.target.value)}>{askingTeams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}</Select>}</Field>
        <Field label={t('opp.request.message')} optional>{(p) => <Textarea {...p} maxLength={300} value={message} onChange={(e) => setMessage(e.target.value)} />}</Field>
      </Modal>
      <Modal open={removeOpen} onClose={() => setRemoveOpen(false)} title={t('opp.cancelListing')} footer={<><Button variant="secondary" onClick={() => setRemoveOpen(false)}>{t('common.cancel')}</Button><Button variant="danger" loading={remove.isPending} onClick={() => remove.mutate()}>{t('opp.cancelListing')}</Button></>}>
        <p className="text-sm">{t('opp.cancelListing.confirm')}</p>
      </Modal>
    </div>
  );
}
