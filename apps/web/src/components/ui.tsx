import { type ComponentProps, type ReactNode, forwardRef, useEffect, useId, useRef } from 'react';
import { Link, type LinkProps } from 'react-router';
import { useI18n } from '../i18n';

export const cx = (...parts: (string | false | null | undefined)[]): string => parts.filter(Boolean).join(' ');

// ───────────────────────── Boutons ─────────────────────────

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-brand-700 text-white hover:bg-brand-800 disabled:bg-brand-300',
  secondary: 'bg-white text-ink border border-line hover:bg-brand-50 disabled:text-muted',
  ghost: 'text-brand-800 hover:bg-brand-50 disabled:text-muted',
  danger: 'bg-red-600 text-white hover:bg-red-700 disabled:bg-red-300',
};
const BASE = 'inline-flex min-h-11 items-center justify-center gap-2 whitespace-nowrap rounded-xl px-4 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed';

export function Spinner({ className }: { className?: string }) {
  return <span role="status" aria-hidden="true" className={cx('inline-block size-4 animate-spin rounded-full border-2 border-current border-t-transparent', className)} />;
}

interface ButtonProps extends ComponentProps<'button'> {
  variant?: Variant;
  loading?: boolean;
}
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant = 'primary', loading, disabled, className, children, type = 'button', ...rest }, ref) {
  return (
    <button ref={ref} type={type} disabled={disabled || loading} aria-busy={loading || undefined} className={cx(BASE, VARIANTS[variant], className)} {...rest}>
      {loading && <Spinner />}
      {children}
    </button>
  );
});

export function LinkButton({ variant = 'primary', className, ...rest }: LinkProps & { variant?: Variant }) {
  return <Link className={cx(BASE, VARIANTS[variant], className)} {...rest} />;
}

// ───────────────────────── Conteneurs ─────────────────────────

export function Card({ className, ...rest }: ComponentProps<'div'>) {
  return <div className={cx('rounded-(--radius-card) border border-line bg-surface p-4 shadow-sm sm:p-5', className)} {...rest} />;
}

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-ink sm:text-3xl">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Section({ title, children, actions }: { title: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="mb-6">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-ink">{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

// ───────────────────────── Étiquettes et messages ─────────────────────────

type Tone = 'neutral' | 'green' | 'amber' | 'red' | 'blue';
const TONES: Record<Tone, string> = {
  neutral: 'bg-canvas text-muted ring-line',
  green: 'bg-brand-50 text-brand-800 ring-brand-200',
  amber: 'bg-amber-50 text-amber-800 ring-amber-200',
  red: 'bg-red-50 text-red-700 ring-red-200',
  blue: 'bg-sky-50 text-sky-800 ring-sky-200',
};
export function Badge({ tone = 'neutral', children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return <span className={cx('inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset', TONES[tone], className)}>{children}</span>;
}

export function Alert({ tone = 'info', children, className }: { tone?: 'info' | 'success' | 'error' | 'warning'; children: ReactNode; className?: string }) {
  const styles = { info: 'bg-sky-50 text-sky-900 border-sky-200', success: 'bg-brand-50 text-brand-900 border-brand-200', error: 'bg-red-50 text-red-800 border-red-200', warning: 'bg-amber-50 text-amber-900 border-amber-200' };
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={cx('rounded-xl border px-4 py-3 text-sm', styles[tone], className)}>
      {children}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { t, tError } = useI18n();
  return (
    <Alert tone="error" className="flex flex-wrap items-center justify-between gap-3">
      <span>{tError(error)}</span>
      {onRetry && (
        <Button variant="secondary" onClick={onRetry} className="min-h-9">
          {t('common.retry')}
        </Button>
      )}
    </Alert>
  );
}

export function EmptyState({ title, text, action }: { title: ReactNode; text?: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-(--radius-card) border border-dashed border-line bg-surface px-6 py-10 text-center">
      <p className="font-semibold text-ink">{title}</p>
      {text && <p className="mx-auto mt-1 max-w-md text-sm text-muted">{text}</p>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

export function Loading() {
  const { t } = useI18n();
  return (
    <div className="flex items-center justify-center gap-2 py-10 text-muted" role="status">
      <Spinner />
      <span>{t('common.loading')}</span>
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('animate-pulse rounded-lg bg-line/70', className)} aria-hidden="true" />;
}

export function StatCard({ label, value, hint }: { label: ReactNode; value: ReactNode; hint?: ReactNode }) {
  return (
    <Card className="p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-muted">{label}</p>
      <p className="num mt-1 text-2xl font-bold text-ink">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
    </Card>
  );
}

// ───────────────────────── Formulaires ─────────────────────────

const CONTROL = 'block min-h-11 w-full rounded-xl border bg-white px-3 py-2 text-base text-ink placeholder:text-muted/70 focus:border-brand-500 disabled:bg-canvas disabled:text-muted sm:text-sm';

export function Field({ label, hint, error, optional, children }: { label: string; hint?: ReactNode; error?: string | null; optional?: boolean; children: (props: { id: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean }) => ReactNode }) {
  const id = useId();
  const { t } = useI18n();
  const described = [hint ? `${id}-hint` : null, error ? `${id}-err` : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-ink">
        {label}
        {optional && <span className="ms-1 font-normal text-muted">({t('common.optional')})</span>}
      </label>
      {children({ id, 'aria-describedby': described, 'aria-invalid': error ? true : undefined })}
      {hint && !error && (
        <p id={`${id}-hint`} className="text-xs text-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-err`} className="text-xs font-medium text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, ComponentProps<'input'> & { invalid?: boolean }>(function Input({ className, invalid, ...rest }, ref) {
  return <input ref={ref} className={cx(CONTROL, invalid || rest['aria-invalid'] ? 'border-red-400' : 'border-line', className)} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, ComponentProps<'select'>>(function Select({ className, ...rest }, ref) {
  return <select ref={ref} className={cx(CONTROL, 'border-line', className)} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, ComponentProps<'textarea'>>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} rows={3} className={cx(CONTROL, rest['aria-invalid'] ? 'border-red-400' : 'border-line', className)} {...rest} />;
});

export function Checkbox({ label, ...rest }: Omit<ComponentProps<'input'>, 'type'> & { label: ReactNode }) {
  const id = useId();
  return (
    <div className="flex items-start gap-3">
      <input id={id} type="checkbox" className="mt-0.5 size-5 shrink-0 rounded border-line accent-brand-700" {...rest} />
      <label htmlFor={id} className="text-sm text-ink">
        {label}
      </label>
    </div>
  );
}

// ───────────────────────── Fenêtre modale ─────────────────────────

/** Basée sur <dialog> natif : focus piégé, fermeture à Échap et lecteurs d'écran gérés par le navigateur. */
export function Modal({ open, onClose, title, children, footer }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog ref={ref} aria-labelledby={titleId} onClose={onClose} onClick={(e) => e.target === ref.current && onClose()} className="m-auto w-[min(92vw,30rem)] rounded-2xl border-0 p-0 shadow-2xl backdrop:bg-black/40">
      {open && (
        <div className="p-5">
          <h2 id={titleId} className="mb-3 text-lg font-semibold">
            {title}
          </h2>
          <div className="space-y-3">{children}</div>
          {footer && <div className="mt-5 flex flex-wrap justify-end gap-2">{footer}</div>}
        </div>
      )}
    </dialog>
  );
}

export function Avatar({ name, url, size = 40 }: { name: string; url?: string | null; size?: number }) {
  const initials = name.split(/\s+/).map((p) => p.charAt(0)).slice(0, 2).join('').toUpperCase();
  return url ? (
    <img src={url} alt="" width={size} height={size} className="rounded-full object-cover" style={{ width: size, height: size }} />
  ) : (
    <span aria-hidden="true" className="inline-flex items-center justify-center rounded-full bg-brand-100 font-semibold text-brand-800" style={{ width: size, height: size, fontSize: size / 2.6 }}>
      {initials || '?'}
    </span>
  );
}
