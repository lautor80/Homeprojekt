import { useEffect, useState, type ComponentProps, type ReactNode } from 'react';
import { AnalyticalTable } from '@ui5/webcomponents-react';
import type { AnalyticalTableColumnDefinition } from '@ui5/webcomponents-react';

/** true auf schmalen Bildschirmen (Handy); reagiert auf Drehen/Größenänderung */
export function useKlein(px = 700): boolean {
  const q = `(max-width: ${px}px)`;
  const [k, setK] = useState(() => (typeof window !== 'undefined' ? window.matchMedia?.(q).matches ?? false : false));
  useEffect(() => {
    const m = window.matchMedia?.(q);
    if (!m) return;
    const f = () => setK(m.matches);
    m.addEventListener('change', f);
    return () => m.removeEventListener('change', f);
  }, [q]);
  return k;
}

type Props = ComponentProps<typeof AnalyticalTable> & {
  columns: AnalyticalTableColumnDefinition[];
  data: Record<string, any>[];
  /** wie viele führende Spalten auf dem Handy die Überschrift einer Karte bilden (Standard 1) */
  titelSpalten?: number;
  /** Zeile hervorheben (z. B. Summenzeile) */
  hervorheben?: (r: Record<string, any>) => boolean;
};

function zelle(c: AnalyticalTableColumnDefinition, r: Record<string, any>): ReactNode {
  const acc = c.accessor;
  const value = typeof acc === 'function' ? (acc as (r: Record<string, any>) => unknown)(r) : typeof acc === 'string' ? r[acc] : undefined;
  if (typeof c.Cell === 'function') return (c.Cell as (x: unknown) => ReactNode)({ row: { original: r, values: r }, value, cell: { value } });
  return value == null || value === '' ? '–' : String(value);
}

/** Bedienelemente in einer Karte: ein Tipp darauf öffnet nicht zusätzlich die Zeile */
const BEDIENBAR = 'ui5-button, ui5-checkbox, ui5-switch, ui5-input, ui5-select, ui5-link, ui5-step-input, ui5-date-picker, ui5-combobox, ui5-multi-combobox, ui5-segmented-button, ui5-toggle-button, ui5-radio-button, ui5-textarea, a, button, input, select, textarea, label';

/**
 * Tabelle, die auf dem Handy als Kartenliste erscheint: Überschrift aus der/den ersten Spalte(n),
 * darunter je Spalte „Bezeichnung: Wert“ in zwei Spalten. Auf größeren Bildschirmen eine normale AnalyticalTable.
 * Spalten ohne Überschrift (Aktionen, Auswahlkästchen) stehen in der Karte unten als eigene, umbrechende Zeile –
 * früher fielen sie weg, die Funktion fehlte auf dem Telefon. `onRowClick` wirkt auch auf die Karte.
 */
export function ResponsiveTable({ columns, data, titelSpalten = 1, hervorheben, noDataText, ...rest }: Props) {
  const klein = useKlein();
  if (!klein) return <AnalyticalTable minRows={1} columns={columns} data={data} noDataText={noDataText} {...rest} />;
  if (!data.length) return <div className="portal-empty" style={{ padding: '0.75rem 1rem' }}>{noDataText ?? 'Keine Daten'}</div>;
  const kopf = columns.slice(0, titelSpalten);
  const felder = columns.slice(titelSpalten).filter((c) => typeof c.Header === 'string' && c.Header);
  // Spalten ohne Text-Überschrift mit eigener Zelle: Aktionen, Auswahl – in der Karte als eigene Zeile
  const aktionen = columns.slice(titelSpalten).filter((c) => !(typeof c.Header === 'string' && c.Header) && typeof c.Cell === 'function');
  const klick = (rest as { onRowClick?: (e: never) => void }).onRowClick;
  return (
    <div className="portal-rt">
      {data.map((r, i) => (
        <div key={i} className={`portal-rt__karte${hervorheben?.(r) ? ' portal-rt__karte--hervor' : ''}${klick ? ' portal-rt__karte--klick' : ''}`}
             onClick={klick ? (e) => {
               if ((e.target as HTMLElement).closest?.(BEDIENBAR)) return;
               klick({ detail: { row: { original: r, values: r, index: i } } } as never);
             } : undefined}>
          <div className="portal-rt__titel">{kopf.map((c, j) => <span key={j}>{zelle(c, r)}</span>)}</div>
          <div className="portal-rt__felder">
            {felder.map((c, j) => (
              <div key={j} className="portal-rt__feld">
                <span className="portal-rt__label">{c.Header as string}</span>
                <span className="portal-rt__wert">{zelle(c, r)}</span>
              </div>
            ))}
          </div>
          {aktionen.length > 0 && <div className="portal-rt__aktionen">{aktionen.map((c, j) => <span key={j}>{zelle(c, r)}</span>)}</div>}
        </div>
      ))}
    </div>
  );
}
