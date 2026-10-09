import type { NotificationPage, NotificationType } from '@footfive/shared';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  EmptyState,
  ErrorState,
  Loading,
  PageHeader,
  Skeleton,
} from '../components/ui';
import { useI18n } from '../i18n';
import { api } from '../lib/api';

/** Où mène chaque notification (identifiants fournis par le serveur dans `data`). */
function target(
  type: NotificationType,
  data: Record<string, string | number | null>,
): string | null {
  const s = (key: string) => (typeof data[key] === 'string' ? (data[key] as string) : null);
  switch (type) {
    case 'BOOKING_CONFIRMED':
    case 'PAYMENT_CONFIRMED':
    case 'BOOKING_CANCELLED':
    case 'BOOKING_EXPIRED':
    case 'REFUND_PROCESSED':
      return s('bookingId') ? `/bookings/${s('bookingId')}` : '/bookings';
    case 'SOLO_ALMOST_FULL':
    case 'SOLO_FULL':
    case 'SOLO_CANCELLED':
      return s('sessionId') ? `/solo/${s('sessionId')}` : '/solo';
    case 'TEAM_INVITATION_RECEIVED':
      return '/teams';
    case 'TEAM_INVITATION_ACCEPTED':
      return s('teamId') ? `/teams/${s('teamId')}` : '/teams';
    case 'OPPONENT_REQUEST_RECEIVED':
    case 'OPPONENT_REJECTED':
      return s('listingId') ? `/opponents/${s('listingId')}` : '/opponents';
    case 'OPPONENT_ACCEPTED':
    case 'MATCH_CANCELLED':
    case 'MATCH_REMINDER':
      return s('matchId') ? `/matches/${s('matchId')}` : '/matches';
    case 'VENUE_APPROVED':
    case 'VENUE_SUSPENDED':
    case 'VENUE_REJECTED':
      return s('venueId') ? `/manage/venues/${s('venueId')}` : '/manage';
    default:
      return null;
  }
}

export function NotificationsPage() {
  const { t, dateTime } = useI18n();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [unread, setUnread] = useState(false);

  const query = useInfiniteQuery({
    queryKey: ['notifications', 'list', unread],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api<NotificationPage>('/me/notifications', {
        query: { unread: unread ? 'true' : undefined, cursor: pageParam, limit: 20 },
      }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['notifications'] });
  const markRead = useMutation({
    mutationFn: (id: string) => api(`/me/notifications/${id}/read`, { method: 'POST' }),
    onSuccess: invalidate,
  });
  const readAll = useMutation({
    mutationFn: () => api('/me/notifications/read-all', { method: 'POST' }),
    onSuccess: invalidate,
  });

  const items = query.data?.pages.flatMap((p) => p.items) ?? [];
  const unreadCount = query.data?.pages[0]?.unreadCount ?? 0;

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        title={t('notif.title')}
        actions={
          unreadCount > 0 ? (
            <Button
              variant="secondary"
              loading={readAll.isPending}
              onClick={() => readAll.mutate()}
            >
              {t('notif.readAll')}
            </Button>
          ) : undefined
        }
      />
      <div className="mb-4">
        <Checkbox
          label={t('notif.unreadOnly')}
          checked={unread}
          onChange={(e) => setUnread(e.target.checked)}
        />
      </div>
      {query.isPending ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-20" />
          ))}
        </div>
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState title={t('notif.empty')} />
      ) : (
        <ul className="space-y-2">
          {items.map((n) => (
            <li key={n.id}>
              <button
                type="button"
                className="block w-full text-start"
                onClick={() => {
                  if (!n.read) markRead.mutate(n.id);
                  const to = target(n.type, n.data);
                  if (to) navigate(to);
                }}
              >
                <Card className={`p-4 ${n.read ? '' : 'border-brand-300 bg-brand-50/50'}`}>
                  <div className="flex items-start justify-between gap-2">
                    <p className="font-semibold">{n.title}</p>
                    {!n.read && <Badge tone="green">•</Badge>}
                  </div>
                  <p className="mt-1 text-sm">{n.body}</p>
                  <p className="num mt-1 text-xs text-muted">{dateTime(n.createdAt)}</p>
                </Card>
              </button>
            </li>
          ))}
          {query.hasNextPage && (
            <li>
              {query.isFetchingNextPage ? (
                <Loading />
              ) : (
                <Button variant="secondary" onClick={() => void query.fetchNextPage()}>
                  {t('common.loadMore')}
                </Button>
              )}
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
