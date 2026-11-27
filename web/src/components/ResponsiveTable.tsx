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
/** so viele Karten auf einmal; weitere über „Weitere anzeigen“ (die Tabelle am Rechner blendet Zeilen selbst ein und aus) */
const SEITE = 100;

/** Überschrift einer Spalte als Beschriftung in der Karte; leer = Spalte ohne Überschrift (Aktionen, Auswahl) */
function beschriftung(c: AnalyticalTableColumnDefinition): ReactNode {
  const h = c.Header as unknown;
  if (typeof h === 'function') { try { return (h as (x: unknown) => ReactNode)({ column: c }); } catch { return ''; } }
  return (h as ReactNode) ?? '';
}

/**
 * Tabelle, die auf dem Handy als Kartenliste erscheint: Überschrift aus der/den ersten Spalte(n),
 * darunter je Spalte „Bezeichnung: Wert“ in zwei Spalten. Auf größeren Bildschirmen eine normale AnalyticalTable.
 * Spalten ohne Überschrift (Aktionen, Auswahlkästchen) stehen in der Karte unten als eigene, umbrechende Zeile –
 * früher fielen sie weg, die Funktion fehlte auf dem Telefon; stehen sie ganz vorn (Auswahl), bleiben sie neben dem Titel.
 * `onRowClick` wirkt auch auf die Karte. Sortieren, Filtern und Gruppieren im Spaltenkopf gibt es in der Kartenansicht nicht.
 */
export function ResponsiveTable({ columns, data, titelSpalten = 1, hervorheben, noDataText, ...rest }: Props) {
  const klein = useKlein();
  const [anzahl, setAnzahl] = useState(SEITE);
  if (!klein) return <AnalyticalTable minRows={1} columns={columns} data={data} noDataText={noDataText} {...rest} />;
  if (!data.length) return <div className="portal-empty" style={{ padding: '0.75rem 1rem' }}>{noDataText ?? 'Keine Daten'}</div>;
  const mitText = columns.map((c) => ({ c, text: beschriftung(c) }));
  // Titel: führende Spalten ohne Überschrift (Auswahlkästchen) und danach die ersten `titelSpalten` Spalten
  let ende = 0;
  while (ende < mitText.length && !mitText[ende].text && typeof mitText[ende].c.Cell === 'function') ende++;
  ende = Math.min(mitText.length, ende + titelSpalten);
  const kopf = mitText.slice(0, ende);
  const felder = mitText.slice(ende).filter((x) => x.text);
  // Spalten ohne Überschrift mit eigener Zelle: Aktionen, Auswahl – in der Karte als eigene Zeile
  const aktionen = mitText.slice(ende).filter((x) => !x.text && typeof x.c.Cell === 'function');
  const klick = (rest as { onRowClick?: (e: never) => void }).onRowClick;
  return (
    <div className="portal-rt">
      {data.slice(0, anzahl).map((r, i) => (
        <div key={i} className={`portal-rt__karte${hervorheben?.(r) ? ' portal-rt__karte--hervor' : ''}${klick ? ' portal-rt__karte--klick' : ''}`}
             onClick={klick ? (e) => {
               if ((e.target as HTMLElement).closest?.(BEDIENBAR)) return;
               klick({ detail: { row: { original: r, values: r, index: i } } } as never);
             } : undefined}>
          <div className="portal-rt__titel">{kopf.map((x, j) => <span key={j}>{zelle(x.c, r)}</span>)}</div>
          <div className="portal-rt__felder">
            {felder.map((x, j) => (
              <div key={j} className="portal-rt__feld">
                <span className="portal-rt__label">{x.text}</span>
                <span className="portal-rt__wert">{zelle(x.c, r)}</span>
              </div>
            ))}
          </div>
          {aktionen.length > 0 && <div className="portal-rt__aktionen">{aktionen.map((x, j) => <span key={j}>{zelle(x.c, r)}</span>)}</div>}
        </div>
      ))}
      {data.length > anzahl && (
        <button type="button" className="portal-rt__mehr" onClick={() => setAnzahl(anzahl + SEITE)}>
          Weitere {Math.min(SEITE, data.length - anzahl)} von {data.length - anzahl} anzeigen
        </button>
      )}
    </div>
  );
}

const vorn = new WeakMap<AnalyticalTableColumnDefinition[], AnalyticalTableColumnDefinition[]>();
/**
 * Für Tabellen, die auf dem Telefon Tabelle bleiben müssen (Baum, Mehrfachauswahl, Gruppierung): Spalten ohne Überschrift
 * mit eigener Zelle (Zeilenaktionen) rücken dort direkt hinter die erste Spalte – sonst stehen sie ganz rechts und sind
 * erst nach weitem seitlichem Rollen zu sehen. Am Rechner bleibt die Reihenfolge. Das Ergebnis wird je Spaltenliste gemerkt
 * (gleiche Liste → dieselbe Referenz, die Tabelle baut sich nicht bei jedem Zeichnen neu auf).
 */
export function aktionenVorn(columns: AnalyticalTableColumnDefinition[]): AnalyticalTableColumnDefinition[] {
  if (typeof window === 'undefined' || !window.matchMedia?.('(max-width: 700px)').matches || columns.length < 3) return columns;
  const da = vorn.get(columns);
  if (da) return da;
  const aktion = (c: AnalyticalTableColumnDefinition, i: number) => i > 0 && !c.Header && typeof c.Cell === 'function' && typeof c.accessor !== 'string';
  const neu = [columns[0], ...columns.filter(aktion), ...columns.filter((c, i) => i > 0 && !aktion(c, i))];
  vorn.set(columns, neu);
  return neu;
}
