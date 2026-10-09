import { openingHoursSchema, type OpeningHoursInput } from '@footfive/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useToast } from '../../components/Toast';
import { Alert, Button, Card, Input } from '../../components/ui';
import { type MessageKey, useI18n } from '../../i18n';
import { api } from '../../lib/api';
import { parseForm } from '../../lib/forms';
import { useVenue } from './VenueManageLayout';

type Interval = { from: string; to: string };
type Week = Record<number, Interval[]>;

export function HoursTab() {
  const { venue, venueId, reload } = useVenue();
  const { t, tError } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [week, setWeek] = useState<Week>(() => Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((d) => [d, (venue.openingHours.find((h) => h.weekday === d)?.intervals ?? []).map(({ from, to }) => ({ from, to }))])));
  const [invalid, setInvalid] = useState(false);

  const save = useMutation({
    mutationFn: (body: OpeningHoursInput) => api(`/manage/venues/${venueId}/opening-hours`, { method: 'PUT', body }),
    onSuccess: () => { toast.success(t('common.saved')); void queryClient.invalidateQueries({ queryKey: ['venue'] }); reload(); },
    onError: (e) => toast.error(tError(e)),
  });

  const update = (day: number, index: number, patch: Partial<Interval>) => setWeek((w) => ({ ...w, [day]: (w[day] ?? []).map((iv, i) => (i === index ? { ...iv, ...patch } : iv)) }));
  const submit = () => {
    const days = Object.entries(week).filter(([, ivs]) => ivs.length > 0).map(([weekday, intervals]) => ({ weekday: Number(weekday), intervals }));
    const parsed = parseForm(openingHoursSchema, { days });
    setInvalid(parsed.errors !== null);
    if (parsed.data) save.mutate(parsed.data);
  };

  return (
    <Card>
      <h2 className="text-lg font-semibold">{t('manage.hours.title')}</h2>
      <p className="mb-4 mt-1 text-sm text-muted">{t('manage.hours.hint')}</p>
      {invalid && <Alert tone="error" className="mb-4">{t('form.fixErrors')}</Alert>}
      <div className="space-y-3">
        {[1, 2, 3, 4, 5, 6, 7].map((day) => (
          <div key={day} className="flex flex-wrap items-center gap-3 border-b border-line/60 pb-3">
            <span className="w-24 font-medium">{t(`weekday.${day}` as MessageKey)}</span>
            <div className="flex flex-1 flex-wrap items-center gap-2">
              {(week[day] ?? []).length === 0 && <span className="text-sm text-muted">{t('venue.closed')}</span>}
              {(week[day] ?? []).map((iv, i) => (
                <span key={i} className="flex items-center gap-1.5">
                  <Input type="time" aria-label={t('manage.hours.open')} className="w-32" value={iv.from} onChange={(e) => update(day, i, { from: e.target.value })} />
                  <span aria-hidden="true">→</span>
                  <Input type="time" aria-label={t('manage.hours.close')} className="w-32" value={iv.to} onChange={(e) => update(day, i, { to: e.target.value })} />
                  <Button variant="ghost" className="min-h-9 px-2 text-red-600" aria-label={t('common.remove')} onClick={() => setWeek((w) => ({ ...w, [day]: (w[day] ?? []).filter((_, j) => j !== i) }))}>✕</Button>
                </span>
              ))}
            </div>
            <Button variant="ghost" className="min-h-9" onClick={() => setWeek((w) => ({ ...w, [day]: [...(w[day] ?? []), { from: '09:00', to: '23:00' }] }))}>{t('manage.hours.addRange')}</Button>
          </div>
        ))}
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button loading={save.isPending} onClick={submit}>{t('common.save')}</Button>
        <Button variant="secondary" onClick={() => setWeek((w) => Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((d) => [d, (w[1] ?? []).map((iv) => ({ ...iv }))])))}>{t('manage.hours.copy')}</Button>
      </div>
    </Card>
  );
}
