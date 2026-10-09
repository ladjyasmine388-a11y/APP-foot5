import type { ReactNode } from 'react';
import { Card } from '../../components/ui';

/** Cadre commun des pages d'authentification : une colonne centrée, lisible sur mobile. */
export function AuthShell({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="mx-auto w-full max-w-md py-4 sm:py-10">
      <Card className="p-6 sm:p-8">
        <h1 className="text-2xl font-bold text-ink">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
        <div className="mt-6 space-y-4">{children}</div>
      </Card>
      {footer && <p className="mt-4 text-center text-sm text-muted">{footer}</p>}
    </div>
  );
}
