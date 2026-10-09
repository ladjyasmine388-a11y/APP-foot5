import type { AdminStats } from '@footfive/shared';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { BarChart } from '../../components/BarChart';
import { Card, ErrorState, Field, Input, Loading, Section, StatCard } from '../../components/ui';
import { useI18n } from '../../i18n';
import { localDate } from '../../i18n/format';
import { api } from '../../lib/api';

export function AdminDashboardPage() {
  const { t, money, number } = useI18n();
  const [range, setRange] = useState({ from: localDate(-29), to: localDate(0) });
  const stats = useQuery({
    queryKey: ['admin', 'stats', range],
    queryFn: () => api<AdminStats>('/admin/stats', { query: range }),
    enabled: range.from <= range.to,
  });
  const s = stats.data;
  return (
    <>
      <div className="mb-4 grid max-w-md grid-cols-2 gap-3">
        <Field label={t('common.from')}>
          {(p) => (
            <Input
              {...p}
              type="date"
              max={range.to}
              value={range.from}
              onChange={(e) => setRange({ ...range, from: e.target.value })}
            />
          )}
        </Field>
        <Field label={t('common.to')}>
          {(p) => (
            <Input
              {...p}
              type="date"
              min={range.from}
              value={range.to}
              onChange={(e) => setRange({ ...range, to: e.target.value })}
            />
          )}
        </Field>
      </div>
      {stats.isPending ? (
        <Loading />
      ) : stats.isError ? (
        <ErrorState error={stats.error} onRetry={() => void stats.refetch()} />
      ) : (
        s && (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <StatCard label={t('admin.dash.gross')} value={money(s.grossMinor)} />
              <StatCard label={t('admin.dash.commission')} value={money(s.commissionMinor)} />
              <StatCard label={t('admin.dash.refunded')} value={money(s.refundedMinor)} />
              <StatCard
                label={t('admin.dash.bookings')}
                value={number(s.bookings.total, 0)}
                hint={`${t('manage.stats.confirmed')} ${s.bookings.confirmed} · ${t('manage.stats.completed')} ${s.bookings.completed} · ${t('manage.stats.cancelled')} ${s.bookings.cancelled}`}
              />
              <StatCard
                label={t('admin.dash.users')}
                value={number(s.users.total, 0)}
                hint={`${t('admin.dash.newUsers')} : ${s.users.newInPeriod}`}
              />
              <StatCard
                label={t('admin.dash.venues')}
                value={number(s.venues.approved, 0)}
                hint={`${s.venues.suspended} / ${s.venues.rejected}`}
              />
              <Link to="venues?status=PENDING">
                <StatCard
                  label={t('admin.dash.pendingVenues')}
                  value={number(s.venues.pending, 0)}
                />
              </Link>
              <StatCard label={t('admin.dash.matches')} value={number(s.matches.scheduled, 0)} />
              <Link to="refunds">
                <StatCard
                  label={t('admin.dash.pendingRefunds')}
                  value={number(s.pendingRefunds, 0)}
                />
              </Link>
              <Link to="refunds">
                <StatCard
                  label={t('admin.dash.failedRefunds')}
                  value={number(s.failedRefunds, 0)}
                />
              </Link>
            </div>
            <Section title={t('admin.dash.daily')}>
              <Card>
                <BarChart
                  data={s.daily.map((d) => ({ label: d.date.slice(8), value: d.revenueMinor }))}
                  format={money}
                />
              </Card>
            </Section>
            <Section title={t('admin.dash.topVenues')}>
              <ul className="space-y-2">
                {s.topVenues.map((v) => (
                  <li
                    key={v.venueId}
                    className="flex justify-between rounded-xl border border-line bg-white px-4 py-3 text-sm"
                  >
                    <span className="font-medium">{v.name}</span>
                    <span className="num text-muted">
                      {v.bookings} · {money(v.grossMinor)}
                    </span>
                  </li>
                ))}
              </ul>
            </Section>
            <p className="text-xs text-muted">{t('manage.stats.note')}</p>
          </>
        )
      )}
    </>
  );
}
