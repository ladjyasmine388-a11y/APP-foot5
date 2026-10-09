import { LOCALES, type ManageVenueSummary, type Locale } from '@footfive/shared';
import { useQuery } from '@tanstack/react-query';
import { type ReactNode, Suspense, useState } from 'react';
import { Link, NavLink, Outlet, useNavigate } from 'react-router';
import { useI18n, type MessageKey } from '../i18n';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Avatar, Alert, Button, LinkButton, Loading, Select, cx } from './ui';
import {
  BellIcon,
  HomeIcon,
  PitchIcon,
  SwordsIcon,
  TicketIcon,
  UserIcon,
  UsersIcon,
} from './icons';

function LanguageSwitch() {
  const { locale, setLocale, t } = useI18n();
  const { status, user, setUser } = useAuth();
  const change = (next: Locale) => {
    setLocale(next);
    // Mémorisé dans le profil pour que les emails et notifications suivent la langue choisie (échec sans conséquence).
    if (status === 'auth' && user) {
      void api('/me', { method: 'PATCH', body: { locale: next } })
        .then(() => setUser({ ...user, locale: next }))
        .catch(() => undefined);
    }
  };
  return (
    <Select
      aria-label={t('lang.label')}
      value={locale}
      onChange={(e) => change(e.target.value as Locale)}
      className="min-h-9 w-auto py-1 ps-2 pe-8 text-sm"
    >
      {LOCALES.map((l) => (
        <option key={l} value={l}>
          {t(`lang.${l}` as MessageKey)}
        </option>
      ))}
    </Select>
  );
}

function NotificationBell() {
  const { t, number } = useI18n();
  const { data } = useQuery({
    queryKey: ['notifications', 'count'],
    queryFn: () => api<{ count: number }>('/me/notifications/unread-count'),
    refetchInterval: 60_000,
  });
  const count = data?.count ?? 0;
  return (
    <Link
      to="/notifications"
      aria-label={`${t('nav.notifications')}${count ? ` (${count})` : ''}`}
      className="relative inline-flex size-11 items-center justify-center rounded-full hover:bg-brand-50"
    >
      <BellIcon />
      {count > 0 && (
        <span className="num absolute end-1 top-1 min-w-5 rounded-full bg-red-600 px-1 text-center text-[11px] font-bold leading-5 text-white">
          {count > 99 ? '99+' : number(count, 0)}
        </span>
      )}
    </Link>
  );
}

const link = ({ isActive }: { isActive: boolean }) =>
  cx(
    'rounded-lg px-3 py-2 text-sm font-medium',
    isActive ? 'bg-brand-50 text-brand-800' : 'text-muted hover:text-ink',
  );

function UserMenu({ isStaff }: { isStaff: boolean }) {
  const { t } = useI18n();
  const { user, isAdmin, logout } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  if (!user) return null;
  const name = `${user.firstName} ${user.lastName}`;
  const close = () => setOpen(false);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={name}
        className="inline-flex size-11 items-center justify-center rounded-full hover:bg-brand-50"
      >
        <Avatar name={name} url={user.avatarUrl} size={34} />
      </button>
      {open && (
        <>
          <button
            type="button"
            aria-hidden="true"
            tabIndex={-1}
            className="fixed inset-0 z-30 cursor-default"
            onClick={close}
          />
          <div
            role="menu"
            className="absolute end-0 z-40 mt-1 w-56 rounded-xl border border-line bg-white p-1.5 shadow-lg"
          >
            <p className="truncate px-3 py-2 text-sm font-semibold">{name}</p>
            {(
              [
                ['/profile', 'nav.profile'],
                ['/bookings', 'nav.bookings'],
                ['/teams', 'nav.teams'],
                ['/matches', 'nav.matches'],
              ] as const
            ).map(([to, key]) => (
              <Link
                key={to}
                to={to}
                role="menuitem"
                onClick={close}
                className="block rounded-lg px-3 py-2 text-sm hover:bg-brand-50"
              >
                {t(key)}
              </Link>
            ))}
            <Link
              to="/manage"
              role="menuitem"
              onClick={close}
              className="block rounded-lg px-3 py-2 text-sm hover:bg-brand-50"
            >
              {isStaff ? t('nav.manage') : t('nav.declareVenue')}
            </Link>
            {isAdmin && (
              <Link
                to="/admin"
                role="menuitem"
                onClick={close}
                className="block rounded-lg px-3 py-2 text-sm font-medium text-brand-800 hover:bg-brand-50"
              >
                {t('nav.admin')}
              </Link>
            )}
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                close();
                void logout().then(() => navigate('/'));
              }}
              className="block w-full rounded-lg px-3 py-2 text-start text-sm text-red-600 hover:bg-red-50"
            >
              {t('nav.logout')}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export function Layout(): ReactNode {
  const { t } = useI18n();
  const { status, user } = useAuth();
  const [resent, setResent] = useState(false);
  const { data: venues } = useQuery({
    queryKey: ['manage', 'venues'],
    queryFn: () => api<ManageVenueSummary[]>('/manage/venues'),
    enabled: status === 'auth',
  });
  const isStaff = (venues?.length ?? 0) > 0;

  const tabs: { to: string; label: MessageKey; icon: ReactNode }[] = [
    { to: '/', label: 'nav.home', icon: <HomeIcon /> },
    { to: '/venues', label: 'nav.venues', icon: <PitchIcon /> },
    { to: '/solo', label: 'nav.solo', icon: <UsersIcon /> },
    { to: '/opponents', label: 'nav.opponents', icon: <SwordsIcon /> },
    status === 'auth'
      ? { to: '/bookings', label: 'nav.bookings', icon: <TicketIcon /> }
      : { to: '/login', label: 'nav.login', icon: <UserIcon /> },
  ];

  return (
    <div className="flex min-h-dvh flex-col">
      <a
        href="#content"
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:m-2 focus:rounded-lg focus:bg-white focus:px-3 focus:py-2"
      >
        {t('common.skipToContent')}
      </a>
      <header className="sticky top-0 z-20 border-b border-line bg-white/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-2 px-4">
          <Link
            to="/"
            className="me-2 flex items-center gap-2 whitespace-nowrap text-lg font-extrabold text-brand-800"
          >
            <span
              aria-hidden="true"
              className="inline-flex size-8 items-center justify-center rounded-lg bg-brand-800 text-white"
            >
              <PitchIcon width={20} height={20} />
            </span>
            {t('brand.name')}
          </Link>
          <nav aria-label={t('nav.menu')} className="hidden items-center gap-1 lg:flex">
            <NavLink to="/venues" className={link}>
              {t('nav.venues')}
            </NavLink>
            <NavLink to="/solo" className={link}>
              {t('nav.solo')}
            </NavLink>
            <NavLink to="/opponents" className={link}>
              {t('nav.opponents')}
            </NavLink>
            {status === 'auth' && (
              <NavLink to="/bookings" className={link}>
                {t('nav.bookings')}
              </NavLink>
            )}
            {status === 'auth' && (
              <NavLink to="/teams" className={link}>
                {t('nav.teams')}
              </NavLink>
            )}
          </nav>
          <div className="ms-auto flex items-center gap-1">
            <LanguageSwitch />
            {status === 'auth' ? (
              <>
                <NotificationBell />
                <UserMenu isStaff={isStaff} />
              </>
            ) : status === 'anon' ? (
              <div className="hidden items-center gap-2 sm:flex">
                <LinkButton to="/login" variant="ghost">
                  {t('nav.login')}
                </LinkButton>
                <LinkButton to="/register">{t('nav.register')}</LinkButton>
              </div>
            ) : null}
          </div>
        </div>
      </header>

      {status === 'auth' && user && !user.emailVerified && (
        <div className="mx-auto w-full max-w-6xl px-4 pt-3">
          <Alert tone="warning" className="flex flex-wrap items-center justify-between gap-2">
            <span>{t('auth.verify.banner')}</span>
            <Button
              variant="secondary"
              className="min-h-9"
              disabled={resent}
              onClick={() => {
                setResent(true);
                void api('/auth/resend-verification', { method: 'POST' }).catch(() => undefined);
              }}
            >
              {resent ? t('auth.verify.resent') : t('auth.verify.resend')}
            </Button>
          </Alert>
        </div>
      )}

      <main id="content" className="mx-auto w-full max-w-6xl flex-1 px-4 py-5 pb-24 lg:pb-8">
        <Suspense fallback={<Loading />}>
          <Outlet />
        </Suspense>
      </main>

      {/* Navigation basse du mobile : zones tactiles de 56 px, zone sûre de l'écran respectée */}
      <nav
        aria-label={t('nav.menu')}
        className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-white pb-[env(safe-area-inset-bottom)] lg:hidden"
      >
        <ul className="mx-auto grid max-w-md grid-cols-5">
          {tabs.map((tab) => (
            <li key={tab.to}>
              <NavLink
                to={tab.to}
                end={tab.to === '/'}
                className={({ isActive }) =>
                  cx(
                    'flex min-h-14 flex-col items-center justify-center gap-0.5 px-1 text-[11px] font-medium',
                    isActive ? 'text-brand-700' : 'text-muted',
                  )
                }
              >
                {tab.icon}
                <span className="max-w-full truncate">{t(tab.label)}</span>
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}
