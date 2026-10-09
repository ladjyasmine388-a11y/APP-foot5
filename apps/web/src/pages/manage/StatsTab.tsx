import type { VenueStats } from '@footfive/shared';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { BarChart } from '../../components/BarChart';
import { Card, ErrorState, Field, Input, Loading, Section, StatCard } from '../../components/ui';
import { useI18n } from '../../i18n';
import { localDate } from '../../i18n/format';
import { api } from '../../lib/api';
import { useVenue } from './VenueManageLayout';

export function StatsTab() {
  const { venueId } = useVenue();
  const { t, money, number } = useI18n();
  const [range, setRange] = useState({ from: localDate(-29), to: localDate(0) });
  const valid = range.from <= range.to;
  const stats = useQuery({
    queryKey: ['manage', venueId, 'stats', range],
    queryFn: () => api<VenueStats>(`/manage/venues/${venueId}/stats`, { query: range }),
    enabled: valid,
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
      {stats.isPending && valid ? (
        <Loading />
      ) : stats.isError ? (
        <ErrorState error={stats.error} onRetry={() => void stats.refetch()} />
      ) : (
        s && (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <StatCard label={t('manage.stats.gross')} value={money(s.grossMinor)} />
              <StatCard label={t('manage.stats.commission')} value={money(s.commissionMinor)} />
              <StatCard label={t('manage.stats.net')} value={money(s.netMinor)} />
              <StatCard label={t('manage.stats.hours')} value={`${number(s.bookedHours)} h`} />
              <StatCard
                label={t('manage.stats.bookings')}
                value={number(s.bookings.total, 0)}
                hint={`${t('manage.stats.confirmed')} ${s.bookings.confirmed} · ${t('manage.stats.completed')} ${s.bookings.completed} · ${t('manage.stats.cancelled')} ${s.bookings.cancelled}`}
              />
              <StatCard
                label={t('manage.stats.noShowRate')}
                value={`${number(s.noShowRate * 100)} %`}
                hint={`${t('manage.stats.noShow')} : ${s.bookings.noShow}`}
              />
              <StatCard label={t('manage.stats.online')} value={money(s.onlineMinor)} />
              <StatCard label={t('manage.stats.onSite')} value={money(s.onSiteMinor)} />
            </div>
            <p className="mt-2 text-xs text-muted">{t('manage.stats.note')}</p>

            <Section title={t('manage.stats.daily')}>
              <Card>
                <BarChart
                  data={s.daily.map((d) => ({ label: d.date.slice(8), value: d.revenueMinor }))}
                  format={money}
                />
              </Card>
            </Section>
            <Section title={t('manage.stats.byHour')}>
              <Card>
                <BarChart
                  data={s.byHour.map((h) => ({
                    label: `${String(h.hour).padStart(2, '0')}h`,
                    value: h.bookings,
                  }))}
                  format={(n) => number(n, 0)}
                />
              </Card>
            </Section>
            <Section title={t('manage.stats.byField')}>
              <ul className="space-y-2">
                {s.byField.map((f) => (
                  <li
                    key={f.fieldId}
                    className="flex justify-between rounded-xl border border-line bg-white px-4 py-3 text-sm"
                  >
                    <span className="font-medium">{f.name}</span>
                    <span className="num text-muted">
                      {f.bookings} · {money(f.grossMinor)}
                    </span>
                  </li>
                ))}
              </ul>
            </Section>
          </>
        )
      )}
    </>
  );
}
