import { NavLink, Outlet, Route, Routes } from 'react-router';
import { PageHeader, cx } from '../../components/ui';
import { type MessageKey, useI18n } from '../../i18n';
import { NotFoundPage } from '../NotFound';
import { AdminAuditPage } from './AdminAudit';
import { AdminCommissionPage, AdminSettingsPage } from './AdminCommission';
import { AdminDashboardPage } from './AdminDashboard';
import { AdminRefundsPage, AdminReviewsPage } from './AdminModeration';
import { AdminUsersPage } from './AdminUsers';
import { AdminVenuesPage } from './AdminVenues';

const TABS: { to: string; label: MessageKey; end?: boolean }[] = [
  { to: '', label: 'admin.tab.dashboard', end: true },
  { to: 'venues', label: 'admin.tab.venues' },
  { to: 'users', label: 'admin.tab.users' },
  { to: 'commission', label: 'admin.tab.commission' },
  { to: 'settings', label: 'admin.tab.settings' },
  { to: 'refunds', label: 'admin.tab.refunds' },
  { to: 'reviews', label: 'admin.tab.reviews' },
  { to: 'audit', label: 'admin.tab.audit' },
];

function AdminLayout() {
  const { t } = useI18n();
  return (
    <>
      <PageHeader title={t('admin.title')} />
      <nav
        aria-label={t('admin.title')}
        className="-mx-1 mb-5 flex gap-1 overflow-x-auto px-1 pb-1"
      >
        {TABS.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            end={tab.end}
            className={({ isActive }) =>
              cx(
                'min-h-10 shrink-0 rounded-lg px-3 py-2 text-sm font-medium',
                isActive ? 'bg-brand-700 text-white' : 'text-muted hover:bg-brand-50',
              )
            }
          >
            {t(tab.label)}
          </NavLink>
        ))}
      </nav>
      <Outlet />
    </>
  );
}

/** Administration de la plateforme, chargée à la demande. Le serveur exige le rôle ADMIN à chaque appel. */
export default function AdminRoutes() {
  return (
    <Routes>
      <Route element={<AdminLayout />}>
        <Route index element={<AdminDashboardPage />} />
        <Route path="venues" element={<AdminVenuesPage />} />
        <Route path="users" element={<AdminUsersPage />} />
        <Route path="commission" element={<AdminCommissionPage />} />
        <Route path="settings" element={<AdminSettingsPage />} />
        <Route path="refunds" element={<AdminRefundsPage />} />
        <Route path="reviews" element={<AdminReviewsPage />} />
        <Route path="audit" element={<AdminAuditPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
