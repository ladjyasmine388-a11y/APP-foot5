import type { AdminUserView, PageOf } from '@footfive/shared';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useToast } from '../../components/Toast';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Loading,
  Modal,
  Select,
  Textarea,
} from '../../components/ui';
import { type MessageKey, useI18n } from '../../i18n';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';

export function AdminUsersPage() {
  const { t, tError, date, number } = useI18n();
  const { user: me } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [filters, setFilters] = useState({ q: '', status: '', role: '' });
  const [blocking, setBlocking] = useState<AdminUserView | null>(null);
  const [reason, setReason] = useState('');

  const list = useInfiniteQuery({
    queryKey: ['admin', 'users', filters],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api<PageOf<AdminUserView>>('/admin/users', {
        query: { ...filters, cursor: pageParam, limit: 25 },
      }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['admin'] });

  const block = useMutation({
    mutationFn: (u: AdminUserView) =>
      api(`/admin/users/${u.id}/block`, { method: 'POST', body: { reason: reason.trim() } }),
    onSuccess: () => {
      setBlocking(null);
      toast.success(t('admin.users.done'));
      refresh();
    },
    onError: (e) => {
      setBlocking(null);
      toast.error(tError(e));
    },
  });
  const unblock = useMutation({
    mutationFn: (u: AdminUserView) => api(`/admin/users/${u.id}/unblock`, { method: 'POST' }),
    onSuccess: () => {
      toast.success(t('admin.users.done'));
      refresh();
    },
    onError: (e) => toast.error(tError(e)),
  });

  return (
    <>
      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <Field label={t('common.search')}>
          {(p) => (
            <Input
              {...p}
              type="search"
              placeholder={t('admin.users.search')}
              value={filters.q}
              onChange={(e) => setFilters({ ...filters, q: e.target.value })}
            />
          )}
        </Field>
        <Field label={t('common.status')}>
          {(p) => (
            <Select
              {...p}
              value={filters.status}
              onChange={(e) => setFilters({ ...filters, status: e.target.value })}
            >
              <option value="">{t('common.all')}</option>
              {(['ACTIVE', 'BLOCKED', 'DELETED'] as const).map((s) => (
                <option key={s} value={s}>
                  {t(`admin.users.status.${s}` as MessageKey)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('admin.users.role.USER')}>
          {(p) => (
            <Select
              {...p}
              value={filters.role}
              onChange={(e) => setFilters({ ...filters, role: e.target.value })}
            >
              <option value="">{t('common.all')}</option>
              {(['USER', 'ADMIN'] as const).map((r) => (
                <option key={r} value={r}>
                  {t(`admin.users.role.${r}` as MessageKey)}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>

      {list.isPending ? (
        <Loading />
      ) : list.isError ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState title={t('common.noResults')} />
      ) : (
        <div className="space-y-2">
          {items.map((u) => (
            <Card key={u.id} className="p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-semibold">
                    {u.firstName} {u.lastName}
                    {u.id === me?.id && ' •'}
                  </p>
                  <p className="truncate text-sm text-muted">
                    {u.email}
                    {!u.emailVerified && ' ⚠'} ·{' '}
                    <span dir="ltr" className="num">
                      {u.phone}
                    </span>
                    {u.city ? ` · ${u.city}` : ''}
                  </p>
                  <p className="num mt-1 text-xs text-muted">
                    {t('profile.stats.played')} {number(u.matchesPlayed, 0)} ·{' '}
                    {t('profile.stats.reliability')} {number(u.reliabilityScore, 0)} % ·{' '}
                    {t('profile.stats.noShow')} {u.noShowCount} · {date(u.createdAt, 'short')}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {u.platformRole === 'ADMIN' && (
                    <Badge tone="blue">{t('admin.users.role.ADMIN')}</Badge>
                  )}
                  <Badge tone={u.status === 'ACTIVE' ? 'green' : 'red'}>
                    {t(`admin.users.status.${u.status}` as MessageKey)}
                  </Badge>
                  {u.status === 'ACTIVE' && u.platformRole !== 'ADMIN' && u.id !== me?.id && (
                    <Button
                      variant="danger"
                      className="min-h-9"
                      onClick={() => {
                        setReason('');
                        setBlocking(u);
                      }}
                    >
                      {t('admin.users.block')}
                    </Button>
                  )}
                  {u.status === 'BLOCKED' && (
                    <Button
                      variant="secondary"
                      className="min-h-9"
                      loading={unblock.isPending && unblock.variables?.id === u.id}
                      onClick={() => unblock.mutate(u)}
                    >
                      {t('admin.users.unblock')}
                    </Button>
                  )}
                </div>
              </div>
            </Card>
          ))}
          {list.hasNextPage && (
            <Button
              variant="secondary"
              loading={list.isFetchingNextPage}
              onClick={() => void list.fetchNextPage()}
            >
              {t('common.loadMore')}
            </Button>
          )}
        </div>
      )}

      <Modal
        open={blocking !== null}
        onClose={() => setBlocking(null)}
        title={`${t('admin.users.block')} — ${blocking?.firstName ?? ''} ${blocking?.lastName ?? ''}`}
        footer={
          <>
            <Button variant="secondary" onClick={() => setBlocking(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="danger"
              disabled={reason.trim().length < 3}
              loading={block.isPending}
              onClick={() => blocking && block.mutate(blocking)}
            >
              {t('admin.users.block')}
            </Button>
          </>
        }
      >
        <p className="text-sm">{t('admin.users.block.text')}</p>
        <Field label={t('common.reason')}>
          {(p) => (
            <Textarea
              {...p}
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          )}
        </Field>
      </Modal>
    </>
  );
}
