import {
  VENUE_STATUSES,
  depositPolicySchema,
  type AdminVenueView,
  type PageOf,
} from '@footfive/shared';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { useToast } from '../../components/Toast';
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Loading,
  Modal,
  Select,
  Textarea,
} from '../../components/ui';
import { type MessageKey, useI18n } from '../../i18n';
import { api } from '../../lib/api';
import { parseForm } from '../../lib/forms';
import { STATUS_TONE } from '../manage/ManageHome';

type Decision = 'approve' | 'reject' | 'suspend' | 'reinstate';
const ACTIONS: Record<AdminVenueView['status'], Decision[]> = {
  PENDING: ['approve', 'reject'],
  REJECTED: ['approve'],
  APPROVED: ['suspend'],
  SUSPENDED: ['reinstate'],
};
const NEEDS_REASON: Decision[] = ['reject', 'suspend'];

export function AdminVenuesPage() {
  const { t, tError, money, date } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? '';
  const [q, setQ] = useState('');
  const [decision, setDecision] = useState<{ venue: AdminVenueView; kind: Decision } | null>(null);
  const [reason, setReason] = useState('');
  const [depositFor, setDepositFor] = useState<AdminVenueView | null>(null);
  const [deposit, setDeposit] = useState({ mode: 'PERCENT', rate: '20', fixed: '0', min: '0' });
  const [depositInvalid, setDepositInvalid] = useState(false);

  const list = useInfiniteQuery({
    queryKey: ['admin', 'venues', status, q],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api<PageOf<AdminVenueView>>('/admin/venues', {
        query: { status, q, cursor: pageParam, limit: 20 },
      }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['admin'] });

  const decide = useMutation({
    mutationFn: ({ venue, kind }: { venue: AdminVenueView; kind: Decision }) =>
      api(`/admin/venues/${venue.id}/${kind}`, {
        method: 'POST',
        body: reason.trim() ? { reason: reason.trim() } : {},
      }),
    onSuccess: () => {
      setDecision(null);
      toast.success(t('admin.venues.done'));
      refresh();
    },
    onError: (e) => {
      setDecision(null);
      toast.error(tError(e));
    },
  });
  const saveDeposit = useMutation({
    mutationFn: ({ venue, body }: { venue: AdminVenueView; body: unknown }) =>
      api(`/admin/venues/${venue.id}/deposit-policy`, {
        method: 'PUT',
        body: { depositPolicy: body },
      }),
    onSuccess: () => {
      setDepositFor(null);
      toast.success(t('common.saved'));
      refresh();
    },
    onError: (e) => toast.error(tError(e)),
  });

  const submitDeposit = () => {
    if (!depositFor) return;
    const parsed = parseForm(depositPolicySchema, {
      mode: deposit.mode,
      rateBps: Math.round(Number(deposit.rate) * 100),
      fixedMinor: Number(deposit.fixed),
      minMinor: Number(deposit.min),
    });
    setDepositInvalid(parsed.errors !== null);
    if (parsed.data) saveDeposit.mutate({ venue: depositFor, body: parsed.data });
  };
  const depositLabel = (v: AdminVenueView) => {
    const p = depositPolicySchema.safeParse(v.depositPolicy);
    if (!p.success) return t('admin.venues.deposit.default');
    return p.data.mode === 'PERCENT' ? `${p.data.rateBps / 100} %` : money(p.data.fixedMinor);
  };

  return (
    <>
      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <Field label={t('common.status')}>
          {(p) => (
            <Select
              {...p}
              value={status}
              onChange={(e) =>
                setParams(e.target.value ? { status: e.target.value } : {}, { replace: true })
              }
            >
              <option value="">{t('common.all')}</option>
              {VENUE_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {t(`manage.status.${s}` as MessageKey)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('common.search')}>
          {(p) => (
            <Input
              {...p}
              type="search"
              placeholder={t('admin.venues.search')}
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          )}
        </Field>
      </div>

      {list.isPending ? (
        <Loading />
      ) : list.isError ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState title={t('common.noResults')} />
      ) : (
        <div className="space-y-3">
          {items.map((v) => (
            <Card key={v.id}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h2 className="font-semibold">{v.name}</h2>
                  <p className="text-sm text-muted">
                    {v.address}, {v.city} · {t('admin.venues.fields', { n: v.fieldCount })}
                  </p>
                </div>
                <Badge tone={STATUS_TONE[v.status]}>
                  {t(`manage.status.${v.status}` as MessageKey)}
                </Badge>
              </div>
              {v.statusReason && (
                <p className="mt-1 text-sm text-muted">
                  {t('common.reason')} : {v.statusReason}
                  {v.statusChangedAt ? ` · ${date(v.statusChangedAt, 'short')}` : ''}
                </p>
              )}
              <div className="mt-3 grid gap-2 text-sm sm:grid-cols-3">
                <div>
                  <p className="text-xs font-medium text-muted">{t('admin.venues.owners')}</p>
                  {v.owners.map((o) => (
                    <p key={o.id}>
                      {o.name} ·{' '}
                      <a dir="ltr" className="num text-brand-700" href={`tel:${o.phone}`}>
                        {o.phone}
                      </a>
                      <br />
                      <span className="text-xs text-muted">{o.email}</span>
                    </p>
                  ))}
                </div>
                <div>
                  <p className="text-xs font-medium text-muted">{t('admin.venues.commission')}</p>
                  <p className="num">
                    {v.commission.rateBps / 100} %
                    {v.commission.fixedMinor ? ` + ${money(v.commission.fixedMinor)}` : ''} (
                    {v.commission.scope === 'VENUE'
                      ? t('admin.venues.commission')
                      : t('admin.commission.global')}
                    )
                  </p>
                </div>
                <div>
                  <p className="text-xs font-medium text-muted">{t('admin.venues.deposit')}</p>
                  <p className="num">{depositLabel(v)}</p>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {ACTIONS[v.status].map((kind) => (
                  <Button
                    key={kind}
                    variant={kind === 'approve' || kind === 'reinstate' ? 'primary' : 'danger'}
                    className="min-h-9"
                    onClick={() => {
                      setReason('');
                      setDecision({ venue: v, kind });
                    }}
                  >
                    {t(`admin.venues.decision.${kind}` as MessageKey)}
                  </Button>
                ))}
                <Button
                  variant="secondary"
                  className="min-h-9"
                  onClick={() => {
                    setDepositInvalid(false);
                    setDepositFor(v);
                  }}
                >
                  {t('admin.venues.deposit.set')}
                </Button>
              </div>
            </Card>
          ))}
          {list.hasNextPage && (
            <Button
              variant="secondary"
              loading={list.isFetchingNextPage}
              onClick={() => void list.fetchNextPage()}
            >
              {t('common.loadMore')}
            </Button>
          )}
        </div>
      )}

      <Modal
        open={decision !== null}
        onClose={() => setDecision(null)}
        title={
          decision
            ? `${t(`admin.venues.decision.${decision.kind}` as MessageKey)} — ${decision.venue.name}`
            : ''
        }
        footer={
          <>
            <Button variant="secondary" onClick={() => setDecision(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              loading={decide.isPending}
              disabled={
                decision !== null &&
                NEEDS_REASON.includes(decision.kind) &&
                reason.trim().length < 3
              }
              onClick={() => decision && decide.mutate(decision)}
            >
              {t('common.confirm')}
            </Button>
          </>
        }
      >
        <Field
          label={
            decision && NEEDS_REASON.includes(decision.kind)
              ? t('admin.venues.reasonRequired')
              : t('common.reason')
          }
          optional={!decision || !NEEDS_REASON.includes(decision.kind)}
        >
          {(p) => (
            <Textarea
              {...p}
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          )}
        </Field>
      </Modal>

      <Modal
        open={depositFor !== null}
        onClose={() => setDepositFor(null)}
        title={`${t('admin.venues.deposit.set')} — ${depositFor?.name ?? ''}`}
        footer={
          <>
            <Button
              variant="ghost"
              loading={saveDeposit.isPending}
              onClick={() => depositFor && saveDeposit.mutate({ venue: depositFor, body: null })}
            >
              {t('admin.venues.deposit.reset')}
            </Button>
            <Button onClick={submitDeposit} loading={saveDeposit.isPending}>
              {t('common.save')}
            </Button>
          </>
        }
      >
        {depositInvalid && <Alert tone="error">{t('form.fixErrors')}</Alert>}
        <Field label={t('admin.settings.depositMode')}>
          {(p) => (
            <Select
              {...p}
              value={deposit.mode}
              onChange={(e) => setDeposit({ ...deposit, mode: e.target.value })}
            >
              <option value="PERCENT">{t('admin.settings.depositMode.PERCENT')}</option>
              <option value="FIXED">{t('admin.settings.depositMode.FIXED')}</option>
            </Select>
          )}
        </Field>
        {deposit.mode === 'PERCENT' ? (
          <Field label={t('admin.venues.deposit.rate')}>
            {(p) => (
              <Input
                {...p}
                type="number"
                inputMode="decimal"
                min={0}
                max={100}
                value={deposit.rate}
                onChange={(e) => setDeposit({ ...deposit, rate: e.target.value })}
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
                value={deposit.fixed}
                onChange={(e) => setDeposit({ ...deposit, fixed: e.target.value })}
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
              value={deposit.min}
              onChange={(e) => setDeposit({ ...deposit, min: e.target.value })}
            />
          )}
        </Field>
      </Modal>
    </>
  );
}
