import { QueryClientProvider } from '@tanstack/react-query';
import { type ReactNode, Suspense, lazy, useState } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router';
import { Layout } from './components/Layout';
import { ToastProvider } from './components/Toast';
import { RequireAdmin, RequireAuth } from './components/guards';
import { Loading } from './components/ui';
import { I18nProvider } from './i18n';
import { AuthProvider } from './lib/auth';
import { createQueryClient } from './lib/query';
import { HomePage } from './pages/Home';
import { NotFoundPage } from './pages/NotFound';

// Chaque page est chargée à la demande : le premier affichage ne télécharge que le socle (routeur, traductions, mise en page).
const NotificationsPage = lazy(() => import('./pages/Notifications').then((m) => ({ default: m.NotificationsPage })));
const ProfilePage = lazy(() => import('./pages/Profile').then((m) => ({ default: m.ProfilePage })));
const ForgotPasswordPage = lazy(() => import('./pages/auth/Recovery').then((m) => ({ default: m.ForgotPasswordPage })));
const ResetPasswordPage = lazy(() => import('./pages/auth/Recovery').then((m) => ({ default: m.ResetPasswordPage })));
const LoginPage = lazy(() => import('./pages/auth/Login').then((m) => ({ default: m.LoginPage })));
const RegisterPage = lazy(() => import('./pages/auth/Register').then((m) => ({ default: m.RegisterPage })));
const VerifyEmailPage = lazy(() => import('./pages/auth/VerifyEmail').then((m) => ({ default: m.VerifyEmailPage })));
const BookPage = lazy(() => import('./pages/bookings/Book').then((m) => ({ default: m.BookPage })));
const BookingDetailPage = lazy(() => import('./pages/bookings/BookingDetail').then((m) => ({ default: m.BookingDetailPage })));
const BookingsListPage = lazy(() => import('./pages/bookings/BookingsList').then((m) => ({ default: m.BookingsListPage })));
const PaymentReturnPage = lazy(() => import('./pages/bookings/PaymentReturn').then((m) => ({ default: m.PaymentReturnPage })));
const MatchDetailPage = lazy(() => import('./pages/matches/Matches').then((m) => ({ default: m.MatchDetailPage })));
const MatchNewPage = lazy(() => import('./pages/matches/Matches').then((m) => ({ default: m.MatchNewPage })));
const MatchesListPage = lazy(() => import('./pages/matches/Matches').then((m) => ({ default: m.MatchesListPage })));
const OpponentDetailPage = lazy(() => import('./pages/opponents/OpponentDetail').then((m) => ({ default: m.OpponentDetailPage })));
const OpponentNewPage = lazy(() => import('./pages/opponents/OpponentNew').then((m) => ({ default: m.OpponentNewPage })));
const OpponentsListPage = lazy(() => import('./pages/opponents/OpponentsList').then((m) => ({ default: m.OpponentsListPage })));
const SoloDetailPage = lazy(() => import('./pages/solo/SoloDetail').then((m) => ({ default: m.SoloDetailPage })));
const SoloListPage = lazy(() => import('./pages/solo/SoloList').then((m) => ({ default: m.SoloListPage })));
const SoloNewPage = lazy(() => import('./pages/solo/SoloNew').then((m) => ({ default: m.SoloNewPage })));
const TeamDetailPage = lazy(() => import('./pages/teams/TeamDetail').then((m) => ({ default: m.TeamDetailPage })));
const TeamsListPage = lazy(() => import('./pages/teams/TeamsList').then((m) => ({ default: m.TeamsListPage })));
const VenueDetailPage = lazy(() => import('./pages/venues/VenueDetail').then((m) => ({ default: m.VenueDetailPage })));
const VenuesListPage = lazy(() => import('./pages/venues/VenuesList').then((m) => ({ default: m.VenuesListPage })));

// Espaces complexe et administration : chargés à la demande (la plupart des joueurs ne les ouvrent jamais).
const ManageRoutes = lazy(() => import('./pages/manage/ManageRoutes'));
const AdminRoutes = lazy(() => import('./pages/admin/AdminRoutes'));

const auth = (page: ReactNode) => <RequireAuth>{page}</RequireAuth>;

export function App() {
  const [queryClient] = useState(createQueryClient);
  return (
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <AuthProvider>
          <ToastProvider>
            <BrowserRouter>
              <Routes>
                <Route element={<Layout />}>
                  <Route index element={<HomePage />} />
                  <Route path="venues" element={<VenuesListPage />} />
                  <Route path="venues/:slug" element={<VenueDetailPage />} />
                  <Route path="solo" element={<SoloListPage />} />
                  <Route path="solo/new" element={auth(<SoloNewPage />)} />
                  <Route path="solo/:id" element={<SoloDetailPage />} />
                  <Route path="opponents" element={<OpponentsListPage />} />
                  <Route path="opponents/new" element={auth(<OpponentNewPage />)} />
                  <Route path="opponents/:id" element={<OpponentDetailPage />} />

                  <Route path="login" element={<LoginPage />} />
                  <Route path="register" element={<RegisterPage />} />
                  <Route path="verify-email" element={<VerifyEmailPage />} />
                  <Route path="forgot-password" element={<ForgotPasswordPage />} />
                  <Route path="reset-password" element={<ResetPasswordPage />} />

                  <Route path="book/:fieldId" element={auth(<BookPage />)} />
                  <Route path="bookings" element={auth(<BookingsListPage />)} />
                  <Route path="bookings/:id" element={auth(<BookingDetailPage />)} />
                  <Route path="bookings/:id/payment" element={auth(<PaymentReturnPage />)} />
                  <Route path="teams" element={auth(<TeamsListPage />)} />
                  <Route path="teams/:id" element={auth(<TeamDetailPage />)} />
                  <Route path="matches" element={auth(<MatchesListPage />)} />
                  <Route path="matches/new" element={auth(<MatchNewPage />)} />
                  <Route path="matches/:id" element={auth(<MatchDetailPage />)} />
                  <Route path="notifications" element={auth(<NotificationsPage />)} />
                  <Route path="profile" element={auth(<ProfilePage />)} />

                  <Route
                    path="manage/*"
                    element={
                      <RequireAuth>
                        <Suspense fallback={<Loading />}>
                          <ManageRoutes />
                        </Suspense>
                      </RequireAuth>
                    }
                  />
                  <Route
                    path="admin/*"
                    element={
                      <RequireAdmin>
                        <Suspense fallback={<Loading />}>
                          <AdminRoutes />
                        </Suspense>
                      </RequireAdmin>
                    }
                  />
                  <Route path="*" element={<NotFoundPage />} />
                </Route>
              </Routes>
            </BrowserRouter>
          </ToastProvider>
        </AuthProvider>
      </I18nProvider>
    </QueryClientProvider>
  );
}
