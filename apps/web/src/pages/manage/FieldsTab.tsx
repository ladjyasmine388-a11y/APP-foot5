import { FIELD_MAX_CAPACITY, FIELD_MIN_CAPACITY, FIELD_SURFACES, createFieldSchema, createPricingRuleSchema, type ManageFieldView, type PricingRuleView } from '@footfive/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { useToast } from '../../components/Toast';
import { Alert, Badge, Button, Card, Checkbox, EmptyState, Field, Input, Modal, Select, Textarea, cx } from '../../components/ui';
import { type MessageKey, useI18n } from '../../i18n';
import { api } from '../../lib/api';
import { type FieldErrors, blankToUndefined, parseForm, serverFieldErrors } from '../../lib/forms';
import { useVenue } from './VenueManageLayout';

type FieldDialog = { mode: 'create' } | { mode: 'edit'; field: ManageFieldView } | { mode: 'delete'; field: ManageFieldView } | null;
type RuleDialog = { mode: 'create'; field: ManageFieldView } | { mode: 'edit'; field: ManageFieldView; rule: PricingRuleView } | null;

const blankField = { name: '', capacity: '10', dimensions: '', surface: 'ARTIFICIAL_TURF', lighting: true, covered: false, description: '' };
const blankRule = { weekdays: [1, 2, 3, 4, 5, 6, 7] as number[], from: '09:00', to: '18:00', price: '3000', priority: '0', isActive: true };

export function FieldsTab() {
  const { venue, venueId, reload } = useVenue();
  const { t, tError, money } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [fieldDialog, setFieldDialog] = useState<FieldDialog>(null);
  const [ruleDialog, setRuleDialog] = useState<RuleDialog>(null);
  const [field, setField] = useState(blankField);
  const [rule, setRule] = useState(blankRule);
  const [errors, setErrors] = useState<FieldErrors>({});

  const done = () => { setFieldDialog(null); setRuleDialog(null); setErrors({}); void queryClient.invalidateQueries({ queryKey: ['venue'] }); reload(); };
  const fail = (e: unknown) => { setErrors(serverFieldErrors(e)); toast.error(tError(e)); };

  const saveField = useMutation({
    mutationFn: (body: unknown) => fieldDialog?.mode === 'edit'
      ? api(`/manage/venues/${venueId}/fields/${fieldDialog.field.id}`, { method: 'PATCH', body })
      : api(`/manage/venues/${venueId}/fields`, { method: 'POST', body }),
    onSuccess: () => { toast.success(t('common.saved')); done(); },
    onError: fail,
  });
  const toggleField = useMutation({
    mutationFn: (f: ManageFieldView) => api(`/manage/venues/${venueId}/fields/${f.id}`, { method: 'PATCH', body: { isActive: !f.isActive } }),
    onSuccess: done,
    onError: fail,
  });
  const deleteField = useMutation({
    mutationFn: (f: ManageFieldView) => api(`/manage/venues/${venueId}/fields/${f.id}`, { method: 'DELETE' }),
    onSuccess: done,
    onError: (e) => { setFieldDialog(null); toast.error(tError(e)); },
  });
  const saveRule = useMutation({
    mutationFn: (body: unknown) => ruleDialog?.mode === 'edit'
      ? api(`/manage/venues/${venueId}/fields/${ruleDialog.field.id}/pricing-rules/${ruleDialog.rule.id}`, { method: 'PATCH', body })
      : api(`/manage/venues/${venueId}/fields/${ruleDialog?.field.id}/pricing-rules`, { method: 'POST', body }),
    onSuccess: () => { toast.success(t('common.saved')); done(); },
    onError: fail,
  });
  const deleteRule = useMutation({
    mutationFn: ({ f, r }: { f: ManageFieldView; r: PricingRuleView }) => api(`/manage/venues/${venueId}/fields/${f.id}/pricing-rules/${r.id}`, { method: 'DELETE' }),
    onSuccess: done,
    onError: (e) => toast.error(tError(e)),
  });

  const openField = (dialog: NonNullable<FieldDialog>) => {
    setErrors({});
    if (dialog.mode === 'create') setField(blankField);
    if (dialog.mode === 'edit') {
      const f = dialog.field;
      setField({ name: f.name, capacity: String(f.capacity), dimensions: f.dimensions ?? '', surface: f.surface, lighting: f.lighting, covered: f.covered, description: f.description ?? '' });
    }
    setFieldDialog(dialog);
  };
  const openRule = (dialog: NonNullable<RuleDialog>) => {
    setErrors({});
    setRule(dialog.mode === 'edit' ? { weekdays: dialog.rule.weekdays, from: dialog.rule.from, to: dialog.rule.to, price: String(dialog.rule.priceMinor), priority: String(dialog.rule.priority), isActive: dialog.rule.isActive } : blankRule);
    setRuleDialog(dialog);
  };

  const submitField = (e: FormEvent) => {
    e.preventDefault();
    const base = { name: field.name, capacity: Number(field.capacity), surface: field.surface, lighting: field.lighting, covered: field.covered };
    const parsed = parseForm(createFieldSchema, { ...base, dimensions: blankToUndefined(field.dimensions), description: blankToUndefined(field.description) });
    setErrors(parsed.errors ?? {});
    if (!parsed.data) return;
    // En modification, un champ vidé doit être EFFACÉ (null), pas ignoré.
    saveField.mutate(fieldDialog?.mode === 'edit' ? { ...parsed.data, dimensions: field.dimensions.trim() || null, description: field.description.trim() || null } : parsed.data);
  };
  const submitRule = (e: FormEvent) => {
    e.preventDefault();
    const parsed = parseForm(createPricingRuleSchema, { weekdays: rule.weekdays, from: rule.from, to: rule.to, priceMinor: Number(rule.price), priority: Number(rule.priority), isActive: rule.isActive });
    setErrors(parsed.errors ?? {});
    if (parsed.data) saveRule.mutate(parsed.data);
  };
  const toggleDay = (d: number) => setRule((r) => ({ ...r, weekdays: r.weekdays.includes(d) ? r.weekdays.filter((x) => x !== d) : [...r.weekdays, d].sort() }));
  const err = (k: string) => (errors[k] ? t('form.invalidField') : null);

  return (
    <>
      <div className="mb-4 flex justify-end"><Button onClick={() => openField({ mode: 'create' })}>{t('manage.fields.add')}</Button></div>
      {venue.fields.length === 0 && <EmptyState title={t('manage.fields.add')} />}
      <div className="space-y-4">
        {venue.fields.map((f) => (
          <Card key={f.id} className={f.isActive ? '' : 'opacity-70'}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">{f.name}</h2>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  <Badge tone="green">{t('venue.capacity', { n: f.capacity })}</Badge>
                  <Badge>{t(`surface.${f.surface}` as MessageKey)}</Badge>
                  {f.lighting && <Badge>{t('field.lighting')}</Badge>}
                  {f.covered && <Badge>{t('field.covered')}</Badge>}
                  {!f.isActive && <Badge tone="red">{t('manage.fields.inactive')}</Badge>}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" className="min-h-9" onClick={() => openField({ mode: 'edit', field: f })}>{t('common.edit')}</Button>
                <Button variant="secondary" className="min-h-9" loading={toggleField.isPending && toggleField.variables?.id === f.id} onClick={() => toggleField.mutate(f)}>{f.isActive ? t('manage.fields.deactivate') : t('manage.fields.activate')}</Button>
                <Button variant="ghost" className="min-h-9 text-red-600" onClick={() => openField({ mode: 'delete', field: f })}>{t('common.delete')}</Button>
              </div>
            </div>

            <div className="mt-4 border-t border-line pt-3">
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-sm font-semibold">{t('manage.pricing.title')}</h3>
                <Button variant="ghost" className="min-h-9" onClick={() => openRule({ mode: 'create', field: f })}>{t('manage.pricing.add')}</Button>
              </div>
              {f.pricingRules.length === 0 ? <Alert tone="warning">{t('manage.pricing.none')}</Alert> : (
                <ul className="space-y-1.5">
                  {f.pricingRules.map((r) => (
                    <li key={r.id} className={cx('flex flex-wrap items-center justify-between gap-2 rounded-lg bg-canvas px-3 py-2 text-sm', !r.isActive && 'opacity-60')}>
                      <span>
                        <span className="num font-semibold">{money(r.priceMinor)}</span>
                        <span className="num ms-2 text-muted">{r.from}–{r.to}</span>
                        <span className="ms-2 text-xs text-muted">{r.weekdays.map((d) => t(`weekday.${d}` as MessageKey).slice(0, 3)).join(' ')} · {t('manage.pricing.priority')} {r.priority}</span>
                        {!r.isActive && <Badge className="ms-2">{t('manage.pricing.inactive')}</Badge>}
                      </span>
                      <span className="flex gap-1">
                        <Button variant="ghost" className="min-h-9 px-2" onClick={() => openRule({ mode: 'edit', field: f, rule: r })}>{t('common.edit')}</Button>
                        <Button variant="ghost" className="min-h-9 px-2 text-red-600" onClick={() => deleteRule.mutate({ f, r })}>{t('common.delete')}</Button>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-2 text-xs text-muted">{t('manage.pricing.hint')}</p>
            </div>
          </Card>
        ))}
      </div>

      <Modal open={fieldDialog?.mode === 'create' || fieldDialog?.mode === 'edit'} onClose={() => setFieldDialog(null)} title={fieldDialog?.mode === 'edit' ? t('common.edit') : t('manage.fields.add')} footer={<><Button variant="secondary" onClick={() => setFieldDialog(null)}>{t('common.cancel')}</Button><Button loading={saveField.isPending} onClick={() => (document.getElementById('field-form') as HTMLFormElement | null)?.requestSubmit()}>{t('common.save')}</Button></>}>
        <form id="field-form" onSubmit={submitField} noValidate className="space-y-3">
          <Field label={t('common.name')} error={err('name')}>{(p) => <Input {...p} maxLength={60} value={field.name} onChange={(e) => setField({ ...field, name: e.target.value })} />}</Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('manage.fields.capacity')} error={err('capacity')}>{(p) => <Select {...p} value={field.capacity} onChange={(e) => setField({ ...field, capacity: e.target.value })}>{Array.from({ length: FIELD_MAX_CAPACITY - FIELD_MIN_CAPACITY + 1 }, (_, i) => FIELD_MIN_CAPACITY + i).map((n) => <option key={n} value={n}>{n}</option>)}</Select>}</Field>
            <Field label={t('manage.fields.surface')}>{(p) => <Select {...p} value={field.surface} onChange={(e) => setField({ ...field, surface: e.target.value })}>{FIELD_SURFACES.map((s) => <option key={s} value={s}>{t(`surface.${s}` as MessageKey)}</option>)}</Select>}</Field>
          </div>
          <Field label={t('manage.fields.dimensions')} optional>{(p) => <Input {...p} maxLength={40} placeholder="40 x 20 m" value={field.dimensions} onChange={(e) => setField({ ...field, dimensions: e.target.value })} />}</Field>
          <div className="flex gap-6">
            <Checkbox label={t('field.lighting')} checked={field.lighting} onChange={(e) => setField({ ...field, lighting: e.target.checked })} />
            <Checkbox label={t('field.covered')} checked={field.covered} onChange={(e) => setField({ ...field, covered: e.target.checked })} />
          </div>
          <Field label={t('common.description')} optional>{(p) => <Textarea {...p} maxLength={1000} value={field.description} onChange={(e) => setField({ ...field, description: e.target.value })} />}</Field>
        </form>
      </Modal>

      <Modal open={fieldDialog?.mode === 'delete'} onClose={() => setFieldDialog(null)} title={t('common.delete')} footer={<><Button variant="secondary" onClick={() => setFieldDialog(null)}>{t('common.cancel')}</Button><Button variant="danger" loading={deleteField.isPending} onClick={() => fieldDialog?.mode === 'delete' && deleteField.mutate(fieldDialog.field)}>{t('common.delete')}</Button></>}>
        <p className="text-sm">{t('manage.fields.delete.confirm')}</p>
      </Modal>

      <Modal open={ruleDialog !== null} onClose={() => setRuleDialog(null)} title={t('manage.pricing.title')} footer={<><Button variant="secondary" onClick={() => setRuleDialog(null)}>{t('common.cancel')}</Button><Button loading={saveRule.isPending} onClick={() => (document.getElementById('rule-form') as HTMLFormElement | null)?.requestSubmit()}>{t('common.save')}</Button></>}>
        <form id="rule-form" onSubmit={submitRule} noValidate className="space-y-3">
          <fieldset>
            <legend className="mb-1.5 text-sm font-medium">{t('manage.pricing.days')}</legend>
            <div className="flex flex-wrap gap-1.5">
              {[1, 2, 3, 4, 5, 6, 7].map((d) => (
                <button key={d} type="button" aria-pressed={rule.weekdays.includes(d)} onClick={() => toggleDay(d)} className={cx('min-h-9 rounded-lg border px-2.5 text-sm', rule.weekdays.includes(d) ? 'border-brand-700 bg-brand-700 text-white' : 'border-line bg-white')}>{t(`weekday.${d}` as MessageKey).slice(0, 3)}</button>
              ))}
            </div>
            {errors['weekdays'] && <p className="mt-1 text-xs font-medium text-red-600">{t('form.required')}</p>}
          </fieldset>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('manage.pricing.from')}>{(p) => <Input {...p} type="time" step={1800} value={rule.from} onChange={(e) => setRule({ ...rule, from: e.target.value })} />}</Field>
            <Field label={t('manage.pricing.to')} error={err('to')}>{(p) => <Input {...p} type="time" step={1800} value={rule.to} onChange={(e) => setRule({ ...rule, to: e.target.value })} />}</Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('manage.pricing.price')} error={err('priceMinor')}>{(p) => <Input {...p} type="number" inputMode="numeric" min={1} value={rule.price} onChange={(e) => setRule({ ...rule, price: e.target.value })} />}</Field>
            <Field label={t('manage.pricing.priority')}>{(p) => <Input {...p} type="number" inputMode="numeric" min={0} max={100} value={rule.priority} onChange={(e) => setRule({ ...rule, priority: e.target.value })} />}</Field>
          </div>
          <Checkbox label={t('manage.pricing.disable')} checked={!rule.isActive} onChange={(e) => setRule({ ...rule, isActive: !e.target.checked })} />
        </form>
      </Modal>
    </>
  );
}
