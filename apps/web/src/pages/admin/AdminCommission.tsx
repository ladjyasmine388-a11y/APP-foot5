import {
  MAX_COMMISSION_BPS,
  SETTING_KEYS,
  depositPolicySchema,
  cancellationPolicySchema,
  setCommissionSchema,
  type CommissionRuleView,
  type SettingKey,
} from '@footfive/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { useToast } from '../../components/Toast';
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  ErrorState,
  Field,
  Input,
  Loading,
  Section,
  Select,
} from '../../components/ui';
import { type MessageKey, useI18n } from '../../i18n';
import { api } from '../../lib/api';
import { parseForm } from '../../lib/forms';

interface Overview {
  global: CommissionRuleView | null;
  venues: (CommissionRuleView & { venueName: string })[];
  history: CommissionRuleView[];
}

export function AdminCommissionPage() {
  const { t, tError, money, date } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const overview = useQuery({
    queryKey: ['admin', 'commission'],
    queryFn: () => api<Overview>('/admin/commission'),
  });
  const [form, setForm] = useState<{ rate: string; fixed: string; reason: string } | null>(null);
  const [invalid, setInvalid] = useState(false);

  const save = useMutation({
    mutationFn: (body: unknown) => api('/admin/commission/global', { method: 'PUT', body }),
    onSuccess: () => {
      toast.success(t('admin.commission.saved'));
      setForm(null);
      void queryClient.invalidateQueries({ queryKey: ['admin'] });
    },
    onError: (e) => toast.error(tError(e)),
  });
  const removeVenue = useMutation({
    mutationFn: (venueId: string) =>
      api(`/admin/commission/venues/${venueId}`, { method: 'DELETE' }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['admin'] }),
    onError: (e) => toast.error(tError(e)),
  });

  if (overview.isPending) return <Loading />;
  if (overview.isError)
    return <ErrorState error={overview.error} onRetry={() => void overview.refetch()} />;
  const { global, venues, history } = overview.data;
  const current = form ?? {
    rate: String((global?.rateBps ?? 0) / 100),
    fixed: String(global?.fixedMinor ?? 0),
    reason: '',
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const parsed = parseForm(setCommissionSchema, {
      rateBps: Math.round(Number(current.rate) * 100),
      fixedMinor: Number(current.fixed),
      ...(current.reason.trim() ? { reason: current.reason.trim() } : {}),
    });
    setInvalid(parsed.errors !== null);
    if (parsed.data) save.mutate(parsed.data);
  };
  const label = (r: CommissionRuleView) =>
    `${r.rateBps / 100} %${r.fixedMinor ? ` + ${money(r.fixedMinor)}` : ''}`;

  return (
    <>
      <Card>
        <h2 className="text-lg font-semibold">{t('admin.commission.global')}</h2>
        <p className="num mt-1 text-3xl font-extrabold text-brand-800">
          {global ? label(global) : '—'}
        </p>
        <p className="mt-1 text-sm text-muted">{t('admin.commission.hint')}</p>
        <form
          onSubmit={submit}
          noValidate
          className="mt-4 grid gap-3 sm:grid-cols-[1fr_1fr_2fr_auto] sm:items-end"
        >
          {invalid && (
            <Alert tone="error" className="sm:col-span-4">
              {t('form.fixErrors')}
            </Alert>
          )}
          <Field label={t('admin.commission.rate')} hint={`≤ ${MAX_COMMISSION_BPS / 100} %`}>
            {(p) => (
              <Input
                {...p}
                type="number"
                inputMode="decimal"
                step="0.01"
                min={0}
                max={MAX_COMMISSION_BPS / 100}
                value={current.rate}
                onChange={(e) => setForm({ ...current, rate: e.target.value })}
              />
            )}
          </Field>
          <Field label={t('admin.commission.fixed')}>
            {(p) => (
              <Input
                {...p}
                type="number"
                inputMode="numeric"
                min={0}
                value={current.fixed}
                onChange={(e) => setForm({ ...current, fixed: e.target.value })}
              />
            )}
          </Field>
          <Field label={t('common.reason')} optional>
            {(p) => (
              <Input
                {...p}
                maxLength={500}
                value={current.reason}
                onChange={(e) => setForm({ ...current, reason: e.target.value })}
              />
            )}
          </Field>
          <Button type="submit" loading={save.isPending} disabled={form === null}>
            {t('common.save')}
          </Button>
        </form>
      </Card>

      <Section title={t('admin.commission.venues')}>
        {venues.length === 0 ? (
          <p className="text-sm text-muted">{t('common.none')}</p>
        ) : (
          <ul className="space-y-2">
            {venues.map((v) => (
              <li
                key={v.id}
                className="flex items-center justify-between gap-3 rounded-xl border border-line bg-white px-4 py-3 text-sm"
              >
                <span className="font-medium">{v.venueName}</span>
                <span className="num">{label(v)}</span>
                <Button
                  variant="ghost"
                  className="min-h-9 text-red-600"
                  onClick={() => v.venueId && removeVenue.mutate(v.venueId)}
                >
                  {t('admin.commission.removeVenue')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={t('admin.commission.history')}>
        <ul className="space-y-1.5">
          {history.map((r) => (
            <li
              key={r.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-white px-3 py-2 text-sm ring-1 ring-line"
            >
              <span className="num font-medium">
                {label(r)}{' '}
                <span className="text-muted">
                  (
                  {r.scope === 'GLOBAL'
                    ? t('admin.commission.global')
                    : t('admin.venues.commission')}
                  )
                </span>
              </span>
              <span className="num text-xs text-muted">
                {t('admin.commission.validity', {
                  from: date(r.validFrom, 'short'),
                  to: r.validTo ? date(r.validTo, 'short') : '…',
                })}
              </span>
              {r.isActive && !r.validTo && (
                <Badge tone="green">{t('admin.commission.current')}</Badge>
              )}
            </li>
          ))}
        </ul>
      </Section>
    </>
  );
}

interface SettingRow {
  key: string;
  value: unknown;
  updatedAt: string | null;
}

export function AdminSettingsPage() {
  const { t, tError } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const settings = useQuery({
    queryKey: ['admin', 'settings'],
    queryFn: () => api<SettingRow[]>('/admin/settings'),
  });
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const save = useMutation({
    mutationFn: ({ key, value }: { key: string; value: unknown }) =>
      api(`/admin/settings/${key}`, { method: 'PUT', body: { value } }),
    onSuccess: (_d, vars) => {
      toast.success(t('admin.settings.saved'));
      setDrafts((d) => {
        const { [vars.key]: _gone, ...rest } = d;
        return rest;
      });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'settings'] });
    },
    onError: (e) => toast.error(tError(e)),
  });

  if (settings.isPending) return <Loading />;
  if (settings.isError)
    return <ErrorState error={settings.error} onRetry={() => void settings.refetch()} />;
  const byKey = new Map(settings.data.map((s) => [s.key, s.value]));

  return (
    <div className="space-y-4">
      {SETTING_KEYS.map((key) => {
        const short = key.replace('booking.', '');
        const label = t(`admin.settings.${short}` as MessageKey);
        const value = byKey.get(key);
        if (key === 'booking.default_deposit')
          return (
            <DepositCard
              key={key}
              label={label}
              value={value}
              onSave={(v) => save.mutate({ key, value: v })}
              saving={save.isPending}
            />
          );
        if (key === 'booking.default_cancellation_policy')
          return (
            <CancellationCard
              key={key}
              label={label}
              value={value}
              onSave={(v) => save.mutate({ key, value: v })}
              saving={save.isPending}
            />
          );
        const text = drafts[key] ?? String(value ?? '');
        return (
          <Card key={key}>
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-60 flex-1">
                <Field label={label}>
                  {(p) => (
                    <Input
                      {...p}
                      type="number"
                      inputMode="numeric"
                      min={0}
                      value={text}
                      onChange={(e) => setDrafts({ ...drafts, [key]: e.target.value })}
                    />
                  )}
                </Field>
              </div>
              <Button
                disabled={drafts[key] === undefined}
                loading={save.isPending && save.variables?.key === key}
                onClick={() => save.mutate({ key, value: Number(text) })}
              >
                {t('common.save')}
              </Button>
            </div>
          </Card>
        );
      })}
    </div>
  );
}

function DepositCard({
  label,
  value,
  onSave,
  saving,
}: {
  label: string;
  value: unknown;
  onSave: (v: unknown) => void;
  saving: boolean;
}) {
  const { t } = useI18n();
  const parsed = depositPolicySchema.safeParse(value);
  const base = parsed.success
    ? parsed.data
    : { mode: 'PERCENT' as const, rateBps: 2000, fixedMinor: 0, minMinor: 0 };
  const [form, setForm] = useState({
    mode: base.mode as string,
    rate: String(base.rateBps / 100),
    fixed: String(base.fixedMinor),
    min: String(base.minMinor),
  });
  const [invalid, setInvalid] = useState(false);
  const submit = () => {
    const p = parseForm(depositPolicySchema, {
      mode: form.mode,
      rateBps: Math.round(Number(form.rate) * 100),
      fixedMinor: Number(form.fixed),
      minMinor: Number(form.min),
    });
    setInvalid(p.errors !== null);
    if (p.data) onSave(p.data);
  };
  return (
    <Card>
      <h3 className="mb-3 font-semibold">{label}</h3>
      {invalid && (
        <Alert tone="error" className="mb-3">
          {t('form.fixErrors')}
        </Alert>
      )}
      <div className="grid gap-3 sm:grid-cols-4 sm:items-end">
        <Field label={t('admin.settings.depositMode')}>
          {(p) => (
            <Select
              {...p}
              value={form.mode}
              onChange={(e) => setForm({ ...form, mode: e.target.value })}
            >
              <option value="PERCENT">{t('admin.settings.depositMode.PERCENT')}</option>
              <option value="FIXED">{t('admin.settings.depositMode.FIXED')}</option>
            </Select>
          )}
        </Field>
        {form.mode === 'PERCENT' ? (
          <Field label={t('admin.venues.deposit.rate')}>
            {(p) => (
              <Input
                {...p}
                type="number"
                inputMode="decimal"
                min={0}
                max={100}
                value={form.rate}
                onChange={(e) => setForm({ ...form, rate: e.target.value })}
              />
            )}
          </Field>
        ) : (
          <Field label={t('admin.settings.fixedDeposit')}>
            {(p) => (
              <Input
                {...p}
                type="number"
                inputMode="numeric"
                min={0}
                value={form.fixed}
                onChange={(e) => setForm({ ...form, fixed: e.target.value })}
              />
            )}
          </Field>
        )}
        <Field label={t('admin.settings.minDeposit')}>
          {(p) => (
            <Input
              {...p}
              type="number"
              inputMode="numeric"
              min={0}
              value={form.min}
              onChange={(e) => setForm({ ...form, min: e.target.value })}
            />
          )}
        </Field>
        <Button loading={saving} onClick={submit}>
          {t('common.save')}
        </Button>
      </div>
    </Card>
  );
}

function CancellationCard({
  label,
  value,
  onSave,
  saving,
}: {
  label: string;
  value: unknown;
  onSave: (v: unknown) => void;
  saving: boolean;
}) {
  const { t } = useI18n();
  const parsed = cancellationPolicySchema.safeParse(value);
  const base = parsed.success ? parsed.data : { freeUntilHoursBefore: 24, refundDeposit: false };
  const [form, setForm] = useState({
    hours: String(base.freeUntilHoursBefore),
    refund: base.refundDeposit,
  });
  return (
    <Card>
      <h3 className="mb-3 font-semibold">{label}</h3>
      <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <Field label={t('manage.info.freeUntil')}>
          {(p) => (
            <Input
              {...p}
              type="number"
              inputMode="numeric"
              min={0}
              max={720}
              value={form.hours}
              onChange={(e) => setForm({ ...form, hours: e.target.value })}
            />
          )}
        </Field>
        <Checkbox
          label={t('manage.info.refundDeposit')}
          checked={form.refund}
          onChange={(e) => setForm({ ...form, refund: e.target.checked })}
        />
        <Button
          loading={saving}
          onClick={() =>
            onSave({ freeUntilHoursBefore: Number(form.hours), refundDeposit: form.refund })
          }
        >
          {t('common.save')}
        </Button>
      </div>
    </Card>
  );
}

export type { SettingKey };
