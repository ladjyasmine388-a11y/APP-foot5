import { PLAYER_LEVELS, PLAYER_POSITIONS, changePasswordSchema, updateProfileSchema, type PlayerStats, type PublicUser, type SessionInfo } from '@footfive/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { useNavigate } from 'react-router';
import { ImageUpload } from '../components/ImageUpload';
import { useToast } from '../components/Toast';
import { Alert, Avatar, Badge, Button, Card, Checkbox, ErrorState, Field, Input, Modal, PageHeader, Section, Select, StatCard } from '../components/ui';
import { type MessageKey, useI18n } from '../i18n';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { type FieldErrors, parseForm, serverFieldErrors } from '../lib/forms';

export function ProfilePage() {
  const { t, tError, dateTime, number } = useI18n();
  const { user, setUser, logout } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [form, setForm] = useState(() => ({
    firstName: user?.firstName ?? '', lastName: user?.lastName ?? '', phone: user?.phone ?? '', city: user?.city ?? '',
    level: user?.level ?? 'BEGINNER', preferredPosition: user?.preferredPosition ?? 'ANY', emailNotifications: user?.preferences['emailNotifications'] !== false,
  }));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [pwd, setPwd] = useState({ currentPassword: '', newPassword: '' });
  const [pwdErrors, setPwdErrors] = useState<FieldErrors>({});
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletePassword, setDeletePassword] = useState('');

  const stats = useQuery({ queryKey: ['me', 'stats'], queryFn: () => api<PlayerStats>('/me/stats') });
  const sessions = useQuery({ queryKey: ['me', 'sessions'], queryFn: () => api<SessionInfo[]>('/me/sessions') });

  const save = useMutation({
    mutationFn: (body: unknown) => api<PublicUser>('/me', { method: 'PATCH', body }),
    onSuccess: (updated) => { setUser(updated); toast.success(t('common.saved')); },
    onError: (e) => setErrors(serverFieldErrors(e)),
  });
  const changePassword = useMutation({
    mutationFn: (body: unknown) => api('/me/change-password', { method: 'POST', body }),
    onSuccess: () => { setPwd({ currentPassword: '', newPassword: '' }); toast.success(t('profile.password.changed')); void queryClient.invalidateQueries({ queryKey: ['me', 'sessions'] }); },
    onError: (e) => { setPwdErrors(serverFieldErrors(e)); toast.error(tError(e)); },
  });
  const revoke = useMutation({ mutationFn: (id: string) => api(`/me/sessions/${id}`, { method: 'DELETE' }), onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['me', 'sessions'] }), onError: (e) => toast.error(tError(e)) });
  const logoutAll = useMutation({ mutationFn: () => api('/auth/logout-all', { method: 'POST' }), onSuccess: async () => { await logout().catch(() => undefined); navigate('/'); } });
  const removeAvatar = useMutation({ mutationFn: () => api('/me/avatar', { method: 'DELETE' }), onSuccess: () => user && setUser({ ...user, avatarUrl: null }) });
  const deleteAccount = useMutation({
    mutationFn: () => api('/me/delete-account', { method: 'POST', body: { password: deletePassword } }),
    onSuccess: async () => { setDeleteOpen(false); await logout().catch(() => undefined); navigate('/'); },
    onError: (e) => { setDeleteOpen(false); toast.error(tError(e)); },
  });

  if (!user) return null;
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((f) => ({ ...f, [key]: value }));
  const err = (key: string) => (errors[key] ? t('form.invalidField') : null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const parsed = parseForm(updateProfileSchema, {
      firstName: form.firstName, lastName: form.lastName, phone: form.phone, city: form.city.trim() || null,
      level: form.level, preferredPosition: form.preferredPosition, preferences: { ...user.preferences, emailNotifications: form.emailNotifications },
    });
    setErrors(parsed.errors ?? {});
    if (parsed.data) save.mutate(parsed.data);
  };
  const submitPassword = (e: FormEvent) => {
    e.preventDefault();
    const parsed = parseForm(changePasswordSchema, pwd);
    setPwdErrors(parsed.errors ?? {});
    if (parsed.data) changePassword.mutate(parsed.data);
  };

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title={t('profile.title')} subtitle={user.email} />

      <Section title={t('profile.stats')}>
        {stats.data ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatCard label={t('profile.stats.played')} value={number(stats.data.matchesPlayed, 0)} />
            <StatCard label={t('profile.stats.reliability')} value={`${number(stats.data.reliabilityScore, 0)} %`} />
            <StatCard label={t('profile.stats.noShow')} value={number(stats.data.noShowCount, 0)} />
            <StatCard label={t('profile.stats.upcoming')} value={number(stats.data.upcomingBookings, 0)} />
          </div>
        ) : stats.isError ? <ErrorState error={stats.error} /> : null}
      </Section>

      <Section title={t('profile.info')}>
        <Card>
          <div className="mb-5 flex flex-wrap items-center gap-4">
            <Avatar name={`${user.firstName} ${user.lastName}`} url={user.avatarUrl} size={72} />
            <ImageUpload path="/me/avatar" label={t('profile.avatar')} onUploaded={(img) => setUser({ ...user, avatarUrl: img.url })} />
            {user.avatarUrl && <Button variant="ghost" loading={removeAvatar.isPending} onClick={() => removeAvatar.mutate()}>{t('profile.avatar.remove')}</Button>}
            {user.emailVerified ? <Badge tone="green">{t('auth.email')} ✓</Badge> : <Badge tone="amber">{t('auth.verify.banner')}</Badge>}
          </div>
          <form onSubmit={submit} noValidate className="space-y-4">
            {save.isError && <Alert tone="error">{tError(save.error)}</Alert>}
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t('auth.firstName')} error={err('firstName')}>{(p) => <Input {...p} value={form.firstName} onChange={(e) => set('firstName', e.target.value)} />}</Field>
              <Field label={t('auth.lastName')} error={err('lastName')}>{(p) => <Input {...p} value={form.lastName} onChange={(e) => set('lastName', e.target.value)} />}</Field>
              <Field label={t('auth.phone')} error={err('phone')}>{(p) => <Input {...p} type="tel" value={form.phone} onChange={(e) => set('phone', e.target.value)} />}</Field>
              <Field label={t('auth.city')} optional>{(p) => <Input {...p} value={form.city} onChange={(e) => set('city', e.target.value)} />}</Field>
              <Field label={t('auth.level')}>{(p) => <Select {...p} value={form.level} onChange={(e) => set('level', e.target.value as typeof form.level)}>{PLAYER_LEVELS.map((l) => <option key={l} value={l}>{t(`level.${l}` as MessageKey)}</option>)}</Select>}</Field>
              <Field label={t('auth.position')}>{(p) => <Select {...p} value={form.preferredPosition} onChange={(e) => set('preferredPosition', e.target.value as typeof form.preferredPosition)}>{PLAYER_POSITIONS.map((l) => <option key={l} value={l}>{t(`position.${l}` as MessageKey)}</option>)}</Select>}</Field>
            </div>
            <Checkbox label={t('profile.emailNotifications')} checked={form.emailNotifications} onChange={(e) => set('emailNotifications', e.target.checked)} />
            <Button type="submit" loading={save.isPending}>{t('common.save')}</Button>
          </form>
        </Card>
      </Section>

      <Section title={t('profile.password')}>
        <Card>
          <form onSubmit={submitPassword} noValidate className="grid gap-3 sm:grid-cols-2 sm:items-end">
            <Field label={t('profile.password.current')} error={pwdErrors['currentPassword'] ? t('form.required') : null}>{(p) => <Input {...p} type="password" autoComplete="current-password" value={pwd.currentPassword} onChange={(e) => setPwd({ ...pwd, currentPassword: e.target.value })} />}</Field>
            <Field label={t('profile.password.new')} hint={t('auth.passwordHint')} error={pwdErrors['newPassword'] ? t('auth.passwordHint') : null}>{(p) => <Input {...p} type="password" autoComplete="new-password" value={pwd.newPassword} onChange={(e) => setPwd({ ...pwd, newPassword: e.target.value })} />}</Field>
            <Button type="submit" loading={changePassword.isPending} className="sm:col-span-2 sm:w-fit">{t('profile.password.new')}</Button>
          </form>
        </Card>
      </Section>

      <Section title={t('profile.sessions')} actions={<Button variant="ghost" loading={logoutAll.isPending} onClick={() => logoutAll.mutate()}>{t('profile.sessions.all')}</Button>}>
        <ul className="space-y-2">
          {sessions.data?.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-white p-3 text-sm">
              <div className="min-w-0">
                <p className="truncate font-medium">{s.userAgent ?? '—'}</p>
                <p className="num text-xs text-muted">{s.ip ?? ''} · {dateTime(s.lastUsedAt ?? s.createdAt)}</p>
              </div>
              {s.current ? <Badge tone="green">{t('profile.sessions.current')}</Badge> : <Button variant="secondary" className="min-h-9" onClick={() => revoke.mutate(s.id)}>{t('profile.sessions.revoke')}</Button>}
            </li>
          ))}
        </ul>
      </Section>

      <Section title={t('profile.delete')}>
        <Alert tone="warning" className="space-y-3">
          <p>{t('profile.delete.text')}</p>
          <Button variant="danger" onClick={() => setDeleteOpen(true)}>{t('profile.delete')}</Button>
        </Alert>
      </Section>

      <Modal open={deleteOpen} onClose={() => setDeleteOpen(false)} title={t('profile.delete')} footer={<><Button variant="secondary" onClick={() => setDeleteOpen(false)}>{t('common.cancel')}</Button><Button variant="danger" disabled={!deletePassword} loading={deleteAccount.isPending} onClick={() => deleteAccount.mutate()}>{t('profile.delete')}</Button></>}>
        <p className="text-sm">{t('profile.delete.text')}</p>
        <Field label={t('profile.delete.confirm')}>{(p) => <Input {...p} type="password" autoComplete="current-password" value={deletePassword} onChange={(e) => setDeletePassword(e.target.value)} />}</Field>
      </Modal>
    </div>
  );
}
