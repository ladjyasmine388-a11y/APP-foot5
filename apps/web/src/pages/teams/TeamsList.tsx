import { PLAYER_LEVELS, createTeamSchema, type TeamInvitationView, type TeamView } from '@footfive/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useToast } from '../../components/Toast';
import { Alert, Avatar, Badge, Button, Card, EmptyState, ErrorState, Field, Input, Loading, Modal, PageHeader, Section, Select, Textarea } from '../../components/ui';
import { type MessageKey, useI18n } from '../../i18n';
import { api } from '../../lib/api';
import { type FieldErrors, blankToUndefined, parseForm, serverFieldErrors } from '../../lib/forms';
import { useMyTeams } from '../../lib/hooks';

export function TeamCard({ team }: { team: TeamView }) {
  const { t } = useI18n();
  return (
    <Link to={`/teams/${team.id}`} className="block">
      <Card className="transition-shadow hover:shadow-md">
        <div className="flex items-center gap-3">
          <Avatar name={team.name} url={team.logoUrl} size={48} />
          <div className="min-w-0">
            <h3 className="truncate font-semibold">{team.name}</h3>
            <p className="text-xs text-muted">{team.city ? `${team.city} · ` : ''}{t('teams.memberCount', { n: team.memberCount })}</p>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          <Badge>{t(`level.${team.level}` as MessageKey)}</Badge>
          {team.myRole && <Badge tone="green">{t(`teams.role.${team.myRole}` as MessageKey)}</Badge>}
        </div>
      </Card>
    </Link>
  );
}

export function TeamsListPage() {
  const { t, tError } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const teams = useMyTeams();
  const invitations = useQuery({ queryKey: ['invitations', 'mine'], queryFn: () => api<TeamInvitationView[]>('/me/invitations') });
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: '', city: '', level: 'BEGINNER', description: '' });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [q, setQ] = useState('');
  const search = useQuery({
    queryKey: ['teams', 'search', q],
    queryFn: () => api<{ items: TeamView[] }>('/teams', { query: { q, limit: 10 } }),
    enabled: q.trim().length >= 2,
  });

  const create = useMutation({
    mutationFn: (body: unknown) => api<TeamView>('/teams', { method: 'POST', body }),
    onSuccess: (team) => { setOpen(false); void queryClient.invalidateQueries({ queryKey: ['teams'] }); navigate(`/teams/${team.id}`); },
    onError: (e) => setErrors(serverFieldErrors(e)),
  });
  const answer = useMutation({
    mutationFn: ({ id, accept }: { id: string; accept: boolean }) => api(`/invitations/${id}/${accept ? 'accept' : 'decline'}`, { method: 'POST' }),
    onSuccess: (_d, vars) => {
      if (vars.accept) toast.success(t('teams.joined'));
      void queryClient.invalidateQueries({ queryKey: ['teams'] });
      void queryClient.invalidateQueries({ queryKey: ['invitations'] });
    },
    onError: (e) => toast.error(tError(e)),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const parsed = parseForm(createTeamSchema, { name: form.name, level: form.level, city: blankToUndefined(form.city), description: blankToUndefined(form.description) });
    setErrors(parsed.errors ?? {});
    if (parsed.data) create.mutate(parsed.data);
  };

  return (
    <>
      <PageHeader title={t('teams.title')} actions={<Button onClick={() => setOpen(true)}>{t('teams.create')}</Button>} />

      {invitations.data && invitations.data.length > 0 && (
        <Section title={t('teams.invitations')}>
          <ul className="space-y-2">
            {invitations.data.map((inv) => (
              <li key={inv.id}>
                <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
                  <span className="text-sm">{t('teams.invitation.text', { by: inv.invitedBy, team: inv.team.name })}</span>
                  <span className="flex gap-2">
                    <Button loading={answer.isPending && answer.variables?.id === inv.id} onClick={() => answer.mutate({ id: inv.id, accept: true })}>{t('teams.accept')}</Button>
                    <Button variant="secondary" onClick={() => answer.mutate({ id: inv.id, accept: false })}>{t('teams.decline')}</Button>
                  </span>
                </Card>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {teams.isPending ? <Loading /> : teams.isError ? <ErrorState error={teams.error} onRetry={() => void teams.refetch()} /> : teams.data.length === 0 ? (
        <EmptyState title={t('teams.empty.title')} text={t('teams.empty.text')} action={<Button onClick={() => setOpen(true)}>{t('teams.create')}</Button>} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{teams.data.map((team) => <TeamCard key={team.id} team={team} />)}</div>
      )}

      <Section title={t('teams.search')}>
        <div className="max-w-md"><Field label={t('common.search')}>{(p) => <Input {...p} type="search" value={q} onChange={(e) => setQ(e.target.value)} />}</Field></div>
        {search.data && (search.data.items.length === 0 ? <p className="mt-3 text-sm text-muted">{t('common.noResults')}</p> : <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{search.data.items.map((team) => <TeamCard key={team.id} team={team} />)}</div>)}
      </Section>

      <Modal open={open} onClose={() => setOpen(false)} title={t('teams.create')} footer={<><Button variant="secondary" onClick={() => setOpen(false)}>{t('common.cancel')}</Button><Button loading={create.isPending} onClick={() => (document.getElementById('team-form') as HTMLFormElement | null)?.requestSubmit()}>{t('common.create')}</Button></>}>
        <form id="team-form" onSubmit={submit} noValidate className="space-y-3">
          {create.isError && <Alert tone="error">{tError(create.error)}</Alert>}
          <Field label={t('teams.name')} error={errors['name'] ? t('form.invalidField') : null}>{(p) => <Input {...p} maxLength={50} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />}</Field>
          <Field label={t('common.city')} optional>{(p) => <Input {...p} value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} />}</Field>
          <Field label={t('common.level')}>{(p) => <Select {...p} value={form.level} onChange={(e) => setForm({ ...form, level: e.target.value })}>{PLAYER_LEVELS.map((l) => <option key={l} value={l}>{t(`level.${l}` as MessageKey)}</option>)}</Select>}</Field>
          <Field label={t('common.description')} optional>{(p) => <Textarea {...p} maxLength={500} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />}</Field>
        </form>
      </Modal>
    </>
  );
}
