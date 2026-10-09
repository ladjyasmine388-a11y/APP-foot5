import { createTeamMatchSchema, setScoreSchema, type MatchView, type PageOf } from '@footfive/shared';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { PinIcon } from '../../components/icons';
import { useToast } from '../../components/Toast';
import { Alert, Avatar, Badge, Button, Card, EmptyState, ErrorState, Field, Input, LinkButton, Loading, Modal, PageHeader, Section, Select, Skeleton, cx } from '../../components/ui';
import { type MessageKey, useI18n } from '../../i18n';
import { ApiError, api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { captainOf, useBookableBookings, useMyTeams, useNow } from '../../lib/hooks';
import { parseForm } from '../../lib/forms';

const TABS = ['upcoming', 'past', 'all'] as const;

function MatchCard({ match }: { match: MatchView }) {
  const { t, dateTime } = useI18n();
  return (
    <Link to={`/matches/${match.id}`} className="block">
      <Card className="transition-shadow hover:shadow-md">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <p className="font-semibold">{match.teamA && match.teamB ? `${match.teamA.name} — ${match.teamB.name}` : match.teamA ? match.teamA.name : t(`matches.source.${match.source}` as MessageKey)}</p>
            <p className="num mt-0.5 text-sm text-brand-800">{dateTime(match.startsAt)}</p>
          </div>
          <Badge tone={match.status === 'SCHEDULED' ? 'green' : match.status === 'CANCELLED' ? 'red' : 'blue'}>{t(`matches.status.${match.status}` as MessageKey)}</Badge>
        </div>
        <p className="mt-2 flex items-center gap-1 text-sm text-muted"><PinIcon width={16} height={16} />{match.venue.name}, {match.venue.city}</p>
        {match.scoreA !== null && <p className="num mt-2 text-lg font-bold">{match.scoreA} – {match.scoreB}</p>}
      </Card>
    </Link>
  );
}

export function MatchesListPage() {
  const { t } = useI18n();
  const [params, setParams] = useSearchParams();
  const when = (TABS as readonly string[]).includes(params.get('when') ?? '') ? (params.get('when') as (typeof TABS)[number]) : 'upcoming';
  const query = useInfiniteQuery({
    queryKey: ['matches', 'mine', when],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api<PageOf<MatchView>>('/me/matches', { query: { when, cursor: pageParam, limit: 10 } }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = query.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <>
      <PageHeader title={t('matches.title')} actions={<LinkButton variant="secondary" to="/matches/new">{t('matches.newTeamMatch')}</LinkButton>} />
      <div role="tablist" className="mb-4 inline-flex rounded-xl border border-line bg-white p-1">
        {TABS.map((tab) => (
          <button key={tab} type="button" role="tab" aria-selected={when === tab} onClick={() => setParams({ when: tab }, { replace: true })} className={cx('min-h-10 rounded-lg px-4 text-sm font-medium', when === tab ? 'bg-brand-700 text-white' : 'text-muted')}>
            {tab === 'upcoming' ? t('common.upcoming') : tab === 'past' ? t('common.past') : t('common.all')}
          </button>
        ))}
      </div>
      {query.isPending ? <div className="space-y-3">{[0, 1].map((i) => <Skeleton key={i} className="h-24" />)}</div> : query.isError ? <ErrorState error={query.error} onRetry={() => void query.refetch()} /> : items.length === 0 ? (
        <EmptyState title={t('matches.empty.title')} text={t('matches.empty.text')} action={<LinkButton to="/solo">{t('nav.solo')}</LinkButton>} />
      ) : (
        <div className="space-y-3">
          {items.map((m) => <MatchCard key={m.id} match={m} />)}
          {query.hasNextPage && (query.isFetchingNextPage ? <Loading /> : <Button variant="secondary" onClick={() => void query.fetchNextPage()}>{t('common.loadMore')}</Button>)}
        </div>
      )}
    </>
  );
}

export function MatchDetailPage() {
  const { id = '' } = useParams();
  const { t, tError, dateTime, time } = useI18n();
  const { user } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const teams = useMyTeams();
  const now = useNow();
  const [scoreOpen, setScoreOpen] = useState(false);
  const [score, setScore] = useState({ a: '0', b: '0' });
  const [cancelOpen, setCancelOpen] = useState(false);

  const query = useQuery({ queryKey: ['match', id], queryFn: () => api<MatchView>(`/matches/${id}`) });
  const refresh = () => { void queryClient.invalidateQueries({ queryKey: ['match', id] }); void queryClient.invalidateQueries({ queryKey: ['matches'] }); void queryClient.invalidateQueries({ queryKey: ['opponent'] }); void queryClient.invalidateQueries({ queryKey: ['opponents'] }); };
  const saveScore = useMutation({
    mutationFn: (body: unknown) => api<MatchView>(`/matches/${id}/score`, { method: 'PUT', body }),
    onSuccess: () => { setScoreOpen(false); toast.success(t('matches.score.saved')); refresh(); },
    onError: (e) => toast.error(tError(e)),
  });
  const cancel = useMutation({
    mutationFn: () => api(`/matches/${id}/cancel`, { method: 'POST' }),
    onSuccess: () => { setCancelOpen(false); refresh(); navigate('/matches'); },
    onError: (e) => { setCancelOpen(false); toast.error(tError(e)); },
  });

  if (query.isPending) return <Loading />;
  if (query.isError) return query.error instanceof ApiError && query.error.status === 404 ? <EmptyState title={t('page.notFound.title')} action={<LinkButton to="/matches">{t('matches.title')}</LinkButton>} /> : <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  const m = query.data;
  const captainTeamIds = new Set(captainOf(teams.data).map((x) => x.id));
  const isCaptainA = Boolean(m.teamA && captainTeamIds.has(m.teamA.id));
  const isCaptainB = Boolean(m.teamB && captainTeamIds.has(m.teamB.id));
  const ended = new Date(m.endsAt).getTime() <= now;
  const canScore = m.teamA && m.teamB && m.status !== 'CANCELLED' && ended && m.scoreA === null && (isCaptainA || isCaptainB);
  const canCancel = m.status === 'SCHEDULED' && !ended && m.source !== 'SOLO_SESSION' && (isCaptainA || isCaptainB);

  const submitScore = (e: FormEvent) => {
    e.preventDefault();
    const parsed = parseForm(setScoreSchema, { scoreA: Number(score.a), scoreB: Number(score.b) });
    if (parsed.data) saveScore.mutate(parsed.data);
  };

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title={m.teamA && m.teamB ? `${m.teamA.name} — ${m.teamB.name}` : t(`matches.source.${m.source}` as MessageKey)} subtitle={`${dateTime(m.startsAt)} – ${time(m.endsAt)}`} actions={<Badge tone={m.status === 'SCHEDULED' ? 'green' : m.status === 'CANCELLED' ? 'red' : 'blue'}>{t(`matches.status.${m.status}` as MessageKey)}</Badge>} />
      <Card>
        <p className="flex items-center gap-1 text-sm text-muted"><PinIcon width={16} height={16} />{m.venue.name}, {m.venue.city} · {m.field.name}</p>
        {m.scoreA !== null && (
          <div className="my-4 flex items-center justify-center gap-6 text-center">
            <div><p className="text-sm text-muted">{m.teamA?.name}</p><p className="num text-4xl font-extrabold">{m.scoreA}</p></div>
            <span className="text-2xl text-muted">–</span>
            <div><p className="text-sm text-muted">{m.teamB?.name}</p><p className="num text-4xl font-extrabold">{m.scoreB}</p></div>
          </div>
        )}
        <div className="mt-3 flex flex-wrap gap-1.5">
          <Badge>{t(`matches.source.${m.source}` as MessageKey)}</Badge>
          {m.playersPerSide && <Badge tone="green">{t('opp.perSide', { n: m.playersPerSide })}</Badge>}
          {m.level && <Badge>{t(`level.${m.level}` as MessageKey)}</Badge>}
        </div>
      </Card>

      <div className="mt-4 flex flex-wrap gap-2">
        {canScore && <Button onClick={() => setScoreOpen(true)}>{t('matches.score.enter')}</Button>}
        {canCancel && <Button variant="danger" onClick={() => setCancelOpen(true)}>{isCaptainB && !isCaptainA ? t('matches.withdraw') : t('matches.cancel')}</Button>}
        {m.soloSessionId && <LinkButton variant="secondary" to={`/solo/${m.soloSessionId}`}>{t('matches.openSession')}</LinkButton>}
        {m.opponentListingId && <LinkButton variant="secondary" to={`/opponents/${m.opponentListingId}`}>{t('opp.title')}</LinkButton>}
      </div>
      {canScore && <p className="mt-2 text-xs text-muted">{t('matches.score.once')}</p>}

      <Section title={`${t('matches.participants')} (${m.participants.length})`}>
        {(['A', 'B', 'NONE'] as const).map((side) => {
          const people = m.participants.filter((p) => p.side === side);
          if (people.length === 0) return null;
          return (
            <div key={side} className="mb-3">
              {side !== 'NONE' && <h3 className="mb-1.5 text-sm font-semibold text-muted">{side === 'A' ? m.teamA?.name ?? t('matches.teamA') : m.teamB?.name ?? t('matches.teamB')}</h3>}
              <ul className="grid gap-2 sm:grid-cols-2">
                {people.map((p) => (
                  <li key={p.id} className="flex items-center gap-3 rounded-xl border border-line bg-white p-2.5">
                    <Avatar name={p.name} url={p.avatarUrl} size={34} />
                    <span className="text-sm">{p.name}{p.id === user?.id && ' •'}</span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </Section>

      <Modal open={scoreOpen} onClose={() => setScoreOpen(false)} title={t('matches.score.enter')} footer={<><Button variant="secondary" onClick={() => setScoreOpen(false)}>{t('common.cancel')}</Button><Button loading={saveScore.isPending} onClick={() => (document.getElementById('score-form') as HTMLFormElement | null)?.requestSubmit()}>{t('common.save')}</Button></>}>
        <form id="score-form" onSubmit={submitScore} className="grid grid-cols-2 gap-3">
          <Field label={m.teamA?.name ?? t('matches.teamA')}>{(p) => <Input {...p} type="number" inputMode="numeric" min={0} max={99} value={score.a} onChange={(e) => setScore({ ...score, a: e.target.value })} />}</Field>
          <Field label={m.teamB?.name ?? t('matches.teamB')}>{(p) => <Input {...p} type="number" inputMode="numeric" min={0} max={99} value={score.b} onChange={(e) => setScore({ ...score, b: e.target.value })} />}</Field>
        </form>
        <Alert tone="warning">{t('matches.score.once')}</Alert>
      </Modal>
      <Modal open={cancelOpen} onClose={() => setCancelOpen(false)} title={t('matches.cancel')} footer={<><Button variant="secondary" onClick={() => setCancelOpen(false)}>{t('common.cancel')}</Button><Button variant="danger" loading={cancel.isPending} onClick={() => cancel.mutate()}>{t('common.confirm')}</Button></>}>
        <p className="text-sm">{t('matches.cancel.confirm')}</p>
      </Modal>
    </div>
  );
}

export function MatchNewPage() {
  const { t, tError, dateTime } = useI18n();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const teams = useMyTeams();
  const bookings = useBookableBookings();
  const [form, setForm] = useState({ teamId: '', bookingId: params.get('booking') ?? '' });
  const create = useMutation({
    mutationFn: (body: unknown) => api<MatchView>('/matches', { method: 'POST', body }),
    onSuccess: (match) => { toast.success(t('matches.new.created')); void queryClient.invalidateQueries({ queryKey: ['matches'] }); void queryClient.invalidateQueries({ queryKey: ['bookings'] }); navigate(`/matches/${match.id}`, { replace: true }); },
  });
  if (teams.isPending || bookings.isPending) return <Loading />;
  if (teams.isError) return <ErrorState error={teams.error} />;
  if (bookings.isError) return <ErrorState error={bookings.error} />;
  const mine = captainOf(teams.data);
  const teamId = form.teamId || mine[0]?.id || '';
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const parsed = parseForm(createTeamMatchSchema, { teamId, bookingId: form.bookingId });
    if (parsed.data) create.mutate(parsed.data);
  };
  return (
    <div className="mx-auto max-w-xl">
      <PageHeader title={t('matches.new.title')} />
      {mine.length === 0 ? <Alert tone="info" className="space-y-3"><p>{t('opp.new.noTeam')}</p><LinkButton to="/teams">{t('teams.create')}</LinkButton></Alert> : bookings.data.length === 0 ? <Alert tone="info">{t('solo.new.noBooking')}</Alert> : (
        <Card>
          <form onSubmit={submit} className="space-y-4">
            {create.isError && <Alert tone="error">{tError(create.error)}</Alert>}
            <Field label={t('opp.new.team')}>{(p) => <Select {...p} value={teamId} onChange={(e) => setForm({ ...form, teamId: e.target.value })}>{mine.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}</Select>}</Field>
            <Field label={t('solo.new.booking')}>{(p) => <Select {...p} value={form.bookingId} onChange={(e) => setForm({ ...form, bookingId: e.target.value })}><option value="">—</option>{bookings.data.map((b) => <option key={b.id} value={b.id}>{b.venue.name} · {b.field.name} · {dateTime(b.startsAt)}</option>)}</Select>}</Field>
            <Button type="submit" loading={create.isPending} disabled={!form.bookingId} className="w-full">{t('common.create')}</Button>
          </form>
        </Card>
      )}
    </div>
  );
}
