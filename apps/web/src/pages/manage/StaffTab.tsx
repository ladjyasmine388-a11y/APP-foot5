import { VENUE_STAFF_ROLES, addStaffSchema, type StaffMemberView } from '@footfive/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { useNavigate } from 'react-router';
import { useToast } from '../../components/Toast';
import { Alert, Avatar, Badge, Button, Card, ErrorState, Field, Input, Loading, Modal, Select } from '../../components/ui';
import { type MessageKey, useI18n } from '../../i18n';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { parseForm } from '../../lib/forms';
import { useVenue } from './VenueManageLayout';

export function StaffTab() {
  const { venueId, can } = useVenue();
  const { t, tError } = useI18n();
  const { user } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const isOwner = can('OWNER');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<(typeof VENUE_STAFF_ROLES)[number]>('STAFF');
  const [invalid, setInvalid] = useState(false);
  const [removing, setRemoving] = useState<StaffMemberView | null>(null);

  const staff = useQuery({ queryKey: ['manage', venueId, 'staff'], queryFn: () => api<StaffMemberView[]>(`/manage/venues/${venueId}/staff`) });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['manage', venueId, 'staff'] });
  const add = useMutation({
    mutationFn: (body: unknown) => api(`/manage/venues/${venueId}/staff`, { method: 'POST', body }),
    onSuccess: () => { setEmail(''); toast.success(t('common.saved')); refresh(); },
    onError: (e) => toast.error(tError(e)),
  });
  const changeRole = useMutation({
    mutationFn: ({ id, role: next }: { id: string; role: string }) => api(`/manage/venues/${venueId}/staff/${id}`, { method: 'PATCH', body: { role: next } }),
    onSuccess: refresh,
    onError: (e) => { toast.error(tError(e)); refresh(); },
  });
  const remove = useMutation({
    mutationFn: (m: StaffMemberView) => api(`/manage/venues/${venueId}/staff/${m.userId}`, { method: 'DELETE' }),
    onSuccess: (_d, m) => {
      setRemoving(null);
      refresh();
      if (m.userId === user?.id) { void queryClient.invalidateQueries({ queryKey: ['manage', 'venues'] }); navigate('/manage'); }
    },
    onError: (e) => { setRemoving(null); toast.error(tError(e)); },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const parsed = parseForm(addStaffSchema, { email, role });
    setInvalid(parsed.errors !== null);
    if (parsed.data) add.mutate(parsed.data);
  };

  return (
    <>
      <h2 className="mb-3 text-lg font-semibold">{t('manage.staff.title')}</h2>
      {staff.isPending ? <Loading /> : staff.isError ? <ErrorState error={staff.error} onRetry={() => void staff.refetch()} /> : (
        <ul className="mb-6 space-y-2">
          {staff.data.map((m) => (
            <li key={m.userId} className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-white p-3">
              <Avatar name={m.name} size={40} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{m.name}{m.userId === user?.id && ' •'}</p>
                <p className="truncate text-xs text-muted">{m.email}</p>
              </div>
              {isOwner ? (
                <Select aria-label={t('common.status')} className="min-h-9 w-auto py-1" value={m.role} onChange={(e) => changeRole.mutate({ id: m.userId, role: e.target.value })}>
                  {VENUE_STAFF_ROLES.map((r) => <option key={r} value={r}>{t(`manage.role.${r}` as MessageKey)}</option>)}
                </Select>
              ) : <Badge>{t(`manage.role.${m.role}` as MessageKey)}</Badge>}
              {(isOwner || m.userId === user?.id) && <Button variant="ghost" className="min-h-9 text-red-600" onClick={() => setRemoving(m)}>{m.userId === user?.id ? t('manage.staff.leave') : t('common.remove')}</Button>}
            </li>
          ))}
        </ul>
      )}
      <p className="mb-6 text-xs text-muted">{t('manage.staff.lastOwner')}</p>

      {isOwner && (
        <Card>
          <h3 className="mb-3 font-semibold">{t('manage.staff.add')}</h3>
          <form onSubmit={submit} noValidate className="flex flex-wrap items-end gap-3">
            <div className="min-w-60 flex-1"><Field label={t('manage.staff.email')} error={invalid ? t('form.invalidField') : null}>{(p) => <Input {...p} type="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} />}</Field></div>
            <Field label={t('common.status')}>{(p) => <Select {...p} value={role} onChange={(e) => setRole(e.target.value as typeof role)}>{VENUE_STAFF_ROLES.map((r) => <option key={r} value={r}>{t(`manage.role.${r}` as MessageKey)}</option>)}</Select>}</Field>
            <Button type="submit" loading={add.isPending}>{t('common.add')}</Button>
          </form>
          {add.isError && <Alert tone="error" className="mt-3">{tError(add.error)}</Alert>}
        </Card>
      )}

      <Modal open={removing !== null} onClose={() => setRemoving(null)} title={t('common.confirm')} footer={<><Button variant="secondary" onClick={() => setRemoving(null)}>{t('common.cancel')}</Button><Button variant="danger" loading={remove.isPending} onClick={() => removing && remove.mutate(removing)}>{t('common.confirm')}</Button></>}>
        <p className="text-sm">{t('manage.staff.remove.confirm')}</p>
      </Modal>
    </>
  );
}
