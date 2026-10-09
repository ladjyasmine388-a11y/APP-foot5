import { Navigate, Route, Routes } from 'react-router';
import { NotFoundPage } from '../NotFound';
import { BookingsTab } from './BookingsTab';
import { FieldsTab } from './FieldsTab';
import { HoursTab } from './HoursTab';
import { InfoTab } from './InfoTab';
import { ManageHomePage, VenueCreatePage } from './ManageHome';
import { StaffTab } from './StaffTab';
import { StatsTab } from './StatsTab';
import { VenueManageLayout } from './VenueManageLayout';

/** Espace complexe, chargé à la demande. Chaque onglet vérifie lui-même le rôle requis (le serveur le revérifie toujours). */
export default function ManageRoutes() {
  return (
    <Routes>
      <Route index element={<ManageHomePage />} />
      <Route path="venues/new" element={<VenueCreatePage />} />
      <Route path="venues/:venueId" element={<VenueManageLayout />}>
        <Route index element={<Navigate to="bookings" replace />} />
        <Route path="bookings" element={<BookingsTab />} />
        <Route path="fields" element={<FieldsTab />} />
        <Route path="hours" element={<HoursTab />} />
        <Route path="info" element={<InfoTab />} />
        <Route path="staff" element={<StaffTab />} />
        <Route path="stats" element={<StatsTab />} />
      </Route>
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
