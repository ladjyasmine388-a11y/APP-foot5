import type { SoloSessionView, PageOf, VenueSearchResponse } from '@footfive/shared';
import { useQuery } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { PitchIcon, SwordsIcon, UsersIcon } from '../components/icons';
import { Button, Card, ErrorState, Field, Input, Section, Skeleton } from '../components/ui';
import { VenueCard } from '../components/venue';
import { useI18n } from '../i18n';
import { localDate } from '../i18n/format';
import { api } from '../lib/api';
import { SoloCard } from './solo/SoloCard';

export function HomePage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ city: '', date: localDate(0), time: '', players: '' });

  const featured = useQuery({
    queryKey: ['venues', 'featured'],
    queryFn: () =>
      api<VenueSearchResponse>('/venues', { auth: false, query: { sort: 'rating', limit: 6 } }),
  });
  const sessions = useQuery({
    queryKey: ['solo', 'home'],
    queryFn: () => api<PageOf<SoloSessionView>>('/solo-sessions', { query: { limit: 3 } }),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(form))
      if (value.trim()) params.set(key, value.trim());
    navigate(`/venues?${params}`);
  };

  return (
    <>
      <section className="relative isolate -mx-4 -mt-5 mb-8 overflow-hidden bg-linear-to-br from-brand-900 via-brand-800 to-brand-600 flex min-h-[32rem] flex-col justify-center px-4 pb-10 pt-10 text-white sm:mx-0 sm:mt-0 sm:min-h-[36rem] sm:rounded-3xl sm:px-10 lg:min-h-[40rem]">
        <img
          src="/foot1.jpg"
          alt=""
          className="absolute inset-0 -z-20 size-full object-cover"
          fetchPriority="high"
        />
        <h1 className="max-w-2xl text-3xl font-extrabold leading-tight tracking-tight drop-shadow-[0_2px_8px_rgba(0,0,0,0.6)] sm:text-5xl">
          {t('home.hero.title')}
        </h1>
        <p className="mt-3 max-w-xl text-base text-white drop-shadow-[0_1px_6px_rgba(0,0,0,0.7)] sm:text-lg">
          {t('home.hero.subtitle')}
        </p>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-controls="home-search"
          className="mt-6 inline-flex w-fit items-center gap-3 rounded-full bg-white px-5 py-3 font-semibold text-brand-700 shadow-xl transition-colors hover:bg-brand-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
        >
          {t('home.search.cta')}
          <svg
            viewBox="0 0 24 24"
            width="22"
            height="22"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            className={`transition-transform duration-300 ${open ? 'rotate-180' : 'animate-bounce motion-reduce:animate-none'}`}
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
        <form
          id="home-search"
          onSubmit={submit}
          className={`mt-4 gap-3 rounded-2xl bg-white p-4 text-ink shadow-xl sm:grid-cols-2 lg:grid-cols-[1.4fr_1fr_1fr_0.8fr_auto] lg:items-end ${open ? 'grid' : 'hidden'}`}
        >
          <Field label={t('common.city')}>
            {(p) => (
              <Input
                {...p}
                autoComplete="address-level2"
                value={form.city}
                onChange={(e) => setForm({ ...form, city: e.target.value })}
              />
            )}
          </Field>
          <Field label={t('common.date')}>
            {(p) => (
              <Input
                {...p}
                type="date"
                min={localDate(0)}
                value={form.date}
                onChange={(e) => setForm({ ...form, date: e.target.value })}
              />
            )}
          </Field>
          <Field label={t('common.time')}>
            {(p) => (
              <Input
                {...p}
                type="time"
                step={3600}
                value={form.time}
                onChange={(e) => setForm({ ...form, time: e.target.value })}
              />
            )}
          </Field>
          <Field label={t('venues.search.players')}>
            {(p) => (
              <Input
                {...p}
                type="number"
                inputMode="numeric"
                min={2}
                max={16}
                value={form.players}
                onChange={(e) => setForm({ ...form, players: e.target.value })}
              />
            )}
          </Field>
          <Button type="submit" className="sm:col-span-2 lg:col-span-1">
            {t('home.search.cta')}
          </Button>
        </form>
      </section>

      <div className="mb-8 grid gap-4 md:grid-cols-3">
        {(
          [
            [
              '/venues',
              <PitchIcon key="p" width={28} height={28} />,
              'home.feature.book.title',
              'home.feature.book.text',
            ],
            [
              '/solo',
              <UsersIcon key="u" width={28} height={28} />,
              'home.feature.solo.title',
              'home.feature.solo.text',
            ],
            [
              '/opponents',
              <SwordsIcon key="s" width={28} height={28} />,
              'home.feature.opponent.title',
              'home.feature.opponent.text',
            ],
          ] as const
        ).map(([to, icon, title, text]) => (
          <Link key={to} to={to} className="group">
            <Card className="h-full transition-shadow group-hover:shadow-md">
              <span className="inline-flex size-12 items-center justify-center rounded-xl bg-brand-50 text-brand-700">
                {icon}
              </span>
              <h2 className="mt-3 text-lg font-semibold">{t(title)}</h2>
              <p className="mt-1 text-sm text-muted">{t(text)}</p>
            </Card>
          </Link>
        ))}
      </div>

      <Section title={t('home.popular')}>
        {featured.isPending ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-64" />
            ))}
          </div>
        ) : featured.isError ? (
          <ErrorState error={featured.error} onRetry={() => void featured.refetch()} />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {featured.data.items.map((v) => (
              <VenueCard key={v.id} venue={v} />
            ))}
          </div>
        )}
      </Section>

      {sessions.data && sessions.data.items.length > 0 && (
        <Section title={t('home.soon')}>
          <div className="grid gap-4 md:grid-cols-3">
            {sessions.data.items.map((s) => (
              <SoloCard key={s.id} session={s} />
            ))}
          </div>
        </Section>
      )}
    </>
  );
}
