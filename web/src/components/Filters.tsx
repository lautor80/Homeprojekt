import type { ReactNode } from 'react';

/** Filterzeile im Kopfbereich einer Seite (Beschriftung klein über dem Feld). */
export function Filters({ children }: { children: ReactNode }) {
  return <div className="portal-filters">{children}</div>;
}

/** Ein Filterfeld; `end` schiebt es an den rechten Rand (z. B. für eine Kennzahl). */
export function Filter({ label, width, end, children }: { label: string; width?: string; end?: boolean; children: ReactNode }) {
  return (
    <div className={`portal-filter${end ? ' portal-filter--end' : ''}`} style={width ? { width } : undefined}>
      <div className="portal-filter__label">{label}</div>
      {children}
    </div>
  );
}

/** Kennzahl im Kopfbereich, z. B. „Gesamt offen 1.250,00 €“ */
export function HeaderKpi({ label, value, state = 'None' }: { label: string; value: ReactNode; state?: 'None' | 'Positive' | 'Negative' | 'Critical' }) {
  return (
    <div className="portal-filter portal-filter--end">
      <div className="portal-filter__label">{label}</div>
      <div className={`portal-kpi__value portal-kpi__value--${state}`}>{value}</div>
    </div>
  );
}
