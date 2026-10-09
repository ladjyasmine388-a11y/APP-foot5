import type { AdminRefundView, AdminReviewView, PageOf } from '@footfive/shared';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useToast } from '../../components/Toast';
import { Stars } from '../../components/venue';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  EmptyState,
  ErrorState,
  Field,
  Loading,
  Modal,
  Select,
  Textarea,
} from '../../components/ui';
import { useI18n } from '../../i18n';
import { api } from '../../lib/api';

const REFUND_STATUSES = [
  'REQUESTED',
  'APPROVED',
  'PROCESSING',
  'SUCCEEDED',
  'FAILED',
  'REJECTED',
] as const;
const TONE = {
  SUCCEEDED: 'green',
  FAILED: 'red',
  REJECTED: 'red',
  REQUESTED: 'amber',
  APPROVED: 'amber',
  PROCESSING: 'amber',
} as const;

export function AdminRefundsPage() {
  const { t, tError, money, dateTime } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState('');
  const list = useInfiniteQuery({
    queryKey: ['admin', 'refunds', status],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api<PageOf<AdminRefundView>>('/admin/refunds', {
        query: { status, cursor: pageParam, limit: 25 },
      }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const retry = useMutation({
    mutationFn: (id: string) => api(`/admin/refunds/${id}/retry`, { method: 'POST' }),
    onSuccess: () => {
      toast.success(t('admin.refunds.retried'));
      void queryClient.invalidateQueries({ queryKey: ['admin'] });
    },
    onError: (e) => toast.error(tError(e)),
  });
  return (
    <>
      <div className="mb-4 max-w-xs">
        <Field label={t('admin.refunds.status')}>
          {(p) => (
            <Select {...p} value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">{t('common.all')}</option>
              {REFUND_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
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
        <EmptyState title={t('admin.refunds.empty')} />
      ) : (
        <div className="space-y-2">
          {items.map((r) => (
            <Card key={r.id} className="p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="num font-semibold">
                    {money(r.amountMinor)}{' '}
                    <span className="font-normal text-muted">· {r.reference}</span>
                  </p>
                  <p className="num text-xs text-muted">
                    {dateTime(r.createdAt)}
                    {r.processedAt ? ` → ${dateTime(r.processedAt)}` : ''}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge tone={TONE[r.status as keyof typeof TONE] ?? 'neutral'}>{r.status}</Badge>
                  {r.status === 'FAILED' && (
                    <Button
                      variant="secondary"
                      className="min-h-9"
                      loading={retry.isPending && retry.variables === r.id}
                      onClick={() => retry.mutate(r.id)}
                    >
                      {t('admin.refunds.retry')}
                    </Button>
                  )}
                </div>
              </div>
              {r.reason && <p className="mt-1 text-sm text-muted">{r.reason}</p>}
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
    </>
  );
}

export function AdminReviewsPage() {
  const { t, tError, date } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [onlyHidden, setOnlyHidden] = useState(false);
  const [target, setTarget] = useState<AdminReviewView | null>(null);
  const [reason, setReason] = useState('');
  const list = useInfiniteQuery({
    queryKey: ['admin', 'reviews', onlyHidden],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api<PageOf<AdminReviewView>>('/admin/reviews', {
        query: { hidden: onlyHidden ? 'true' : undefined, cursor: pageParam, limit: 25 },
      }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const moderate = useMutation({
    mutationFn: (review: AdminReviewView) =>
      api(`/admin/reviews/${review.id}/${review.hidden ? 'unhide' : 'hide'}`, {
        method: 'POST',
        body: { reason: reason.trim() },
      }),
    onSuccess: () => {
      setTarget(null);
      toast.success(t('admin.reviews.done'));
      void queryClient.invalidateQueries({ queryKey: ['admin'] });
    },
    onError: (e) => {
      setTarget(null);
      toast.error(tError(e));
    },
  });
  return (
    <>
      <div className="mb-4">
        <Checkbox
          label={t('admin.reviews.onlyHidden')}
          checked={onlyHidden}
          onChange={(e) => setOnlyHidden(e.target.checked)}
        />
      </div>
      {list.isPending ? (
        <Loading />
      ) : list.isError ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState title={t('common.noResults')} />
      ) : (
        <div className="space-y-2">
          {items.map((r) => (
            <Card key={r.id} className={`p-4 ${r.hidden ? 'opacity-70' : ''}`}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="font-semibold">{r.venue.name}</p>
                  <p className="text-xs text-muted">
                    {r.author} · {date(r.createdAt, 'short')}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Stars value={r.rating} />
                  {r.hidden && <Badge tone="red">{t('admin.reviews.hidden')}</Badge>}
                  <Button
                    variant="secondary"
                    className="min-h-9"
                    onClick={() => {
                      setReason('');
                      setTarget(r);
                    }}
                  >
                    {r.hidden ? t('admin.reviews.unhide') : t('admin.reviews.hide')}
                  </Button>
                </div>
              </div>
              {r.comment && <p className="mt-2 whitespace-pre-line text-sm">{r.comment}</p>}
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
        open={target !== null}
        onClose={() => setTarget(null)}
        title={target?.hidden ? t('admin.reviews.unhide') : t('admin.reviews.hide')}
        footer={
          <>
            <Button variant="secondary" onClick={() => setTarget(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              loading={moderate.isPending}
              disabled={reason.trim().length < 3}
              onClick={() => target && moderate.mutate(target)}
            >
              {t('common.confirm')}
            </Button>
          </>
        }
      >
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
