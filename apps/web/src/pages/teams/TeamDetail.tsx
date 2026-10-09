import {
  PLAYER_LEVELS,
  inviteToTeamSchema,
  updateTeamSchema,
  type TeamInvitationAdminView,
  type TeamMemberView,
  type TeamView,
} from '@footfive/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { ImageUpload } from '../../components/ImageUpload';
import { useToast } from '../../components/Toast';
import {
  Alert,
  Avatar,
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Input,
  LinkButton,
  Loading,
  Modal,
  PageHeader,
  Section,
  Select,
  Textarea,
} from '../../components/ui';
import { type MessageKey, useI18n } from '../../i18n';
import { ApiError, api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { type FieldErrors, parseForm, serverFieldErrors } from '../../lib/forms';

type Confirm =
  | { kind: 'leave' }
  | { kind: 'dissolve' }
  | { kind: 'remove'; member: TeamMemberView }
  | { kind: 'transfer'; member: TeamMemberView }
  | null;

export function TeamDetailPage() {
  const { id = '' } = useParams();
  const { t, tError, date } = useI18n();
  const { user } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [edit, setEdit] = useState<null | {
    name: string;
    city: string;
    level: string;
    description: string;
  }>(null);
  const [editErrors, setEditErrors] = useState<FieldErrors>({});

  const team = useQuery({ queryKey: ['team', id], queryFn: () => api<TeamView>(`/teams/${id}`) });
  const isMember = team.data?.myRole !== null && team.data?.myRole !== undefined;
  const isCaptain = team.data?.myRole === 'CAPTAIN';
  const members = useQuery({
    queryKey: ['team', id, 'members'],
    queryFn: () => api<TeamMemberView[]>(`/teams/${id}/members`),
    enabled: isMember,
  });
  const pending = useQuery({
    queryKey: ['team', id, 'invitations'],
    queryFn: () => api<TeamInvitationAdminView[]>(`/teams/${id}/invitations`),
    enabled: isCaptain,
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['team', id] });
    void queryClient.invalidateQueries({ queryKey: ['teams'] });
  };
  const fail = (e: unknown) => toast.error(tError(e));

  const invite = useMutation({
    mutationFn: (body: unknown) => api(`/teams/${id}/invitations`, { method: 'POST', body }),
    onSuccess: () => {
      setInviteEmail('');
      toast.success(t('teams.invite.sent'));
      refresh();
    },
    onError: fail,
  });
  const cancelInvite = useMutation({
    mutationFn: (invId: string) => api(`/teams/${id}/invitations/${invId}`, { method: 'DELETE' }),
    onSuccess: refresh,
    onError: fail,
  });
  const update = useMutation({
    mutationFn: (body: unknown) => api<TeamView>(`/teams/${id}`, { method: 'PATCH', body }),
    onSuccess: () => {
      setEdit(null);
      toast.success(t('teams.updated'));
      refresh();
    },
    onError: (e) => setEditErrors(serverFieldErrors(e)),
  });
  const act = useMutation({
    mutationFn: async (c: NonNullable<Confirm>) => {
      if (c.kind === 'leave') await api(`/teams/${id}/leave`, { method: 'POST' });
      else if (c.kind === 'dissolve') await api(`/teams/${id}`, { method: 'DELETE' });
      else if (c.kind === 'remove')
        await api(`/teams/${id}/members/${c.member.id}`, { method: 'DELETE' });
      else
        await api(`/teams/${id}/transfer-captaincy`, {
          method: 'POST',
          body: { userId: c.member.id },
        });
      return c.kind;
    },
    onSuccess: (kind) => {
      setConfirm(null);
      refresh();
      if (kind === 'leave' || kind === 'dissolve') navigate('/teams');
    },
    onError: (e) => {
      setConfirm(null);
      fail(e);
    },
  });

  if (team.isPending) return <Loading />;
  if (team.isError) {
    return team.error instanceof ApiError && team.error.status === 404 ? (
      <EmptyState
        title={t('page.notFound.title')}
        action={<LinkButton to="/teams">{t('teams.title')}</LinkButton>}
      />
    ) : (
      <ErrorState error={team.error} onRetry={() => void team.refetch()} />
    );
  }
  const tm = team.data;

  const submitInvite = (e: FormEvent) => {
    e.preventDefault();
    const parsed = parseForm(inviteToTeamSchema, { email: inviteEmail });
    setInviteError(parsed.errors ? t('form.invalidField') : null);
    if (parsed.data) invite.mutate(parsed.data);
  };
  const submitEdit = (e: FormEvent) => {
    e.preventDefault();
    if (!edit) return;
    const parsed = parseForm(updateTeamSchema, {
      name: edit.name,
      city: edit.city.trim() || null,
      level: edit.level,
      description: edit.description.trim() || null,
    });
    setEditErrors(parsed.errors ?? {});
    if (parsed.data) update.mutate(parsed.data);
  };
  const confirmText =
    confirm?.kind === 'leave'
      ? t('teams.leave.confirm')
      : confirm?.kind === 'dissolve'
        ? t('teams.dissolve.confirm')
        : confirm?.kind === 'transfer'
          ? t('teams.transfer.confirm')
          : confirm
            ? t('teams.removeMember')
            : '';

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title={tm.name}
        subtitle={`${tm.city ? tm.city + ' · ' : ''}${t(`level.${tm.level}` as MessageKey)} · ${t('teams.memberCount', { n: tm.memberCount })}`}
        actions={
          isCaptain ? (
            <Button
              variant="secondary"
              onClick={() =>
                setEdit({
                  name: tm.name,
                  city: tm.city ?? '',
                  level: tm.level,
                  description: tm.description ?? '',
                })
              }
            >
              {t('common.edit')}
            </Button>
          ) : undefined
        }
      />
      <Card>
        <div className="flex flex-wrap items-center gap-4">
          <Avatar name={tm.name} url={tm.logoUrl} size={72} />
          <div className="text-sm">
            <p className="text-muted">{t('teams.captain')}</p>
            <p className="font-semibold">{tm.captain.name}</p>
          </div>
          {isCaptain && (
            <div className="ms-auto">
              <ImageUpload
                path={`/teams/${id}/logo`}
                label={t('teams.logo.change')}
                onUploaded={refresh}
              />
            </div>
          )}
        </div>
        {tm.description && <p className="mt-3 whitespace-pre-line text-sm">{tm.description}</p>}
      </Card>

      <Section title={t('teams.members')}>
        {!isMember ? (
          <Alert tone="info">{t('teams.notMember')}</Alert>
        ) : members.isPending ? (
          <Loading />
        ) : members.isError ? (
          <ErrorState error={members.error} />
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2">
            {members.data.map((m) => (
              <li
                key={m.id}
                className="flex items-center gap-3 rounded-xl border border-line bg-white p-3"
              >
                <Avatar name={m.name} url={m.avatarUrl} size={40} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {m.name}
                    {m.id === user?.id && ' •'}
                  </p>
                  <p className="text-xs text-muted">
                    {t(`position.${m.preferredPosition}` as MessageKey)} ·{' '}
                    {t(`level.${m.level}` as MessageKey)} · {date(m.joinedAt, 'short')}
                  </p>
                </div>
                {m.role === 'CAPTAIN' ? (
                  <Badge tone="green">{t('teams.role.CAPTAIN')}</Badge>
                ) : (
                  isCaptain && (
                    <span className="flex gap-1">
                      <Button
                        variant="ghost"
                        className="min-h-9 px-2 text-xs"
                        onClick={() => setConfirm({ kind: 'transfer', member: m })}
                      >
                        {t('teams.transfer')}
                      </Button>
                      <Button
                        variant="ghost"
                        className="min-h-9 px-2 text-xs text-red-600"
                        onClick={() => setConfirm({ kind: 'remove', member: m })}
                      >
                        {t('common.remove')}
                      </Button>
                    </span>
                  )
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>

      {isCaptain && (
        <Section title={t('teams.invite')}>
          <Card>
            <form onSubmit={submitInvite} noValidate className="flex flex-wrap items-end gap-3">
              <div className="min-w-60 flex-1">
                <Field label={t('teams.invite.email')} error={inviteError}>
                  {(p) => (
                    <Input
                      {...p}
                      type="email"
                      inputMode="email"
                      value={inviteEmail}
                      onChange={(e) => setInviteEmail(e.target.value)}
                    />
                  )}
                </Field>
              </div>
              <Button type="submit" loading={invite.isPending}>
                {t('teams.invite')}
              </Button>
            </form>
            {pending.data && pending.data.length > 0 && (
              <div className="mt-4">
                <h3 className="mb-2 text-sm font-semibold">{t('teams.invite.pending')}</h3>
                <ul className="space-y-1.5">
                  {pending.data.map((inv) => (
                    <li
                      key={inv.id}
                      className="flex items-center justify-between gap-3 rounded-lg bg-canvas px-3 py-2 text-sm"
                    >
                      <span className="truncate">{inv.invitee}</span>
                      <Button
                        variant="ghost"
                        className="min-h-9 text-xs"
                        onClick={() => cancelInvite.mutate(inv.id)}
                      >
                        {t('teams.invite.cancel')}
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Card>
        </Section>
      )}

      {isMember && (
        <div className="mt-6 flex flex-wrap gap-2 border-t border-line pt-4">
          {!isCaptain && (
            <Button variant="secondary" onClick={() => setConfirm({ kind: 'leave' })}>
              {t('teams.leave')}
            </Button>
          )}
          {isCaptain && (
            <Button variant="danger" onClick={() => setConfirm({ kind: 'dissolve' })}>
              {t('teams.dissolve')}
            </Button>
          )}
          {isCaptain && tm.memberCount <= 1 && (
            <p className="self-center text-xs text-muted">{t('teams.leave.confirm')}</p>
          )}
        </div>
      )}

      <Modal
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={t('common.confirm')}
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirm(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="danger"
              loading={act.isPending}
              onClick={() => confirm && act.mutate(confirm)}
            >
              {t('common.confirm')}
            </Button>
          </>
        }
      >
        <p className="text-sm">{confirmText}</p>
      </Modal>

      <Modal
        open={edit !== null}
        onClose={() => setEdit(null)}
        title={t('common.edit')}
        footer={
          <>
            <Button variant="secondary" onClick={() => setEdit(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              loading={update.isPending}
              onClick={() =>
                (document.getElementById('edit-team') as HTMLFormElement | null)?.requestSubmit()
              }
            >
              {t('common.save')}
            </Button>
          </>
        }
      >
        {edit && (
          <form id="edit-team" onSubmit={submitEdit} noValidate className="space-y-3">
            {update.isError && <Alert tone="error">{tError(update.error)}</Alert>}
            <Field
              label={t('teams.name')}
              error={editErrors['name'] ? t('form.invalidField') : null}
            >
              {(p) => (
                <Input
                  {...p}
                  maxLength={50}
                  value={edit.name}
                  onChange={(e) => setEdit({ ...edit, name: e.target.value })}
                />
              )}
            </Field>
            <Field label={t('common.city')} optional>
              {(p) => (
                <Input
                  {...p}
                  value={edit.city}
                  onChange={(e) => setEdit({ ...edit, city: e.target.value })}
                />
              )}
            </Field>
            <Field label={t('common.level')}>
              {(p) => (
                <Select
                  {...p}
                  value={edit.level}
                  onChange={(e) => setEdit({ ...edit, level: e.target.value })}
                >
                  {PLAYER_LEVELS.map((l) => (
                    <option key={l} value={l}>
                      {t(`level.${l}` as MessageKey)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label={t('common.description')} optional>
              {(p) => (
                <Textarea
                  {...p}
                  maxLength={500}
                  value={edit.description}
                  onChange={(e) => setEdit({ ...edit, description: e.target.value })}
                />
              )}
            </Field>
          </form>
        )}
      </Modal>
    </div>
  );
}
