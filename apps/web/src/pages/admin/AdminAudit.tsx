import type { AuditLogView, PageOf } from '@footfive/shared';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Alert, Badge, Button, Card, EmptyState, ErrorState, Field, Input, Loading } from '../../components/ui';
import { useI18n } from '../../i18n';
import { api } from '../../lib/api';

export function AdminAuditPage() {
  const { t, dateTime } = useI18n();
  const [filters, setFilters] = useState({ action: '', entityType: '', from: '', to: '' });
  const list = useInfiniteQuery({
    queryKey: ['admin', 'audit', filters],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api<PageOf<AuditLogView>>('/admin/audit-logs', { query: { ...filters, cursor: pageParam, limit: 30 } }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <>
      <Alert tone="info" className="mb-4">{t('admin.audit.readOnly')}</Alert>
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label={t('admin.audit.action')}>{(p) => <Input {...p} placeholder="venue." value={filters.action} onChange={(e) => setFilters({ ...filters, action: e.target.value })} />}</Field>
        <Field label={t('admin.audit.entity')}>{(p) => <Input {...p} placeholder="Venue" value={filters.entityType} onChange={(e) => setFilters({ ...filters, entityType: e.target.value })} />}</Field>
        <Field label={t('common.from')}>{(p) => <Input {...p} type="date" value={filters.from} onChange={(e) => setFilters({ ...filters, from: e.target.value })} />}</Field>
        <Field label={t('common.to')}>{(p) => <Input {...p} type="date" value={filters.to} onChange={(e) => setFilters({ ...filters, to: e.target.value })} />}</Field>
      </div>
      {list.isPending ? <Loading /> : list.isError ? <ErrorState error={list.error} onRetry={() => void list.refetch()} /> : items.length === 0 ? <EmptyState title={t('common.noResults')} /> : (
        <div className="space-y-2">
          {items.map((a) => (
            <Card key={a.id} className="p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-mono text-xs font-semibold">{a.action}</span>
                <span className="num text-xs text-muted">{dateTime(a.createdAt)}</span>
              </div>
              <p className="mt-1 text-xs text-muted"><Badge>{a.actorRole}</Badge> {a.entityType}{a.entityId ? ` · ${a.entityId.slice(0, 8)}…` : ''}</p>
              {(a.before !== null || a.after !== null) && (
                <details className="mt-1">
                  <summary className="cursor-pointer text-xs text-brand-700">{t('admin.audit.before')} / {t('admin.audit.after')}</summary>
                  <pre dir="ltr" className="mt-1 overflow-x-auto rounded-lg bg-canvas p-2 text-xs">{JSON.stringify({ before: a.before, after: a.after }, null, 2)}</pre>
                </details>
              )}
            </Card>
          ))}
          {list.hasNextPage && <Button variant="secondary" loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>{t('common.loadMore')}</Button>}
        </div>
      )}
    </>
  );
}
