import { useI18n } from '../i18n';

/**
 * Histogramme sans dépendance : des barres CSS accessibles (chaque valeur est aussi dans un tableau masqué visuellement pour
 * les lecteurs d'écran). Suffit pour des séries de quelques dizaines de points.
 */
export function BarChart({ data, format }: { data: { label: string; value: number }[]; format: (n: number) => string }) {
  const { t } = useI18n();
  const max = Math.max(1, ...data.map((d) => d.value));
  if (data.length === 0) return <p className="text-sm text-muted">{t('common.noResults')}</p>;
  return (
    <>
      <div className="flex h-40 items-end gap-1" aria-hidden="true">
        {data.map((d) => (
          <div key={d.label} className="group flex h-full min-w-0 flex-1 flex-col items-center justify-end" title={`${d.label} : ${format(d.value)}`}>
            <div className="w-full rounded-t bg-brand-500 transition-colors group-hover:bg-brand-700" style={{ height: `${Math.max(d.value > 0 ? 4 : 0, (d.value / max) * 100)}%` }} />
          </div>
        ))}
      </div>
      <div className="mt-1 flex gap-1 text-[10px] text-muted" aria-hidden="true">
        {data.map((d, i) => (
          <span key={d.label} className="num min-w-0 flex-1 truncate text-center">{data.length <= 16 || i % Math.ceil(data.length / 12) === 0 ? d.label : ''}</span>
        ))}
      </div>
      <table className="sr-only">
        <tbody>
          {data.map((d) => (
            <tr key={d.label}><th scope="row">{d.label}</th><td>{format(d.value)}</td></tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
