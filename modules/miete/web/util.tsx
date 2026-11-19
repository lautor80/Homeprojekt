import type { ReactNode } from 'react';
import { DatePicker, Input, Option, Select } from '@ui5/webcomponents-react';
import { FieldBox } from '@core/components/FormFields';

export const M = '/api/m/miete';

export const betrag = (v: number | null | undefined) => (v ?? 0).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const eur = (v: number | null | undefined) => `${betrag(v)} €`;
export function dat(iso: string | null | undefined): string {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}.${m}.${y}`;
}
const MONATE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
export const monatText = (iso: string) => `${MONATE[+iso.slice(5, 7) - 1]} ${iso.slice(0, 4)}`;
export const heute = () => new Date().toISOString().slice(0, 10);
/** Zahl aus einer Eingabe mit Komma oder Punkt */
export function zahl(s: string | number | null | undefined): number {
  if (typeof s === 'number') return s;
  const t = String(s ?? '').trim();
  return Number(t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t) || 0;
}
export const zahlText = (v: number | null | undefined) => (v === null || v === undefined ? '' : String(v).replace('.', ','));

export type Schluessel = 'flaeche' | 'personen' | 'einheiten' | 'anteil' | 'verbrauch' | 'direkt';
export const SCHLUESSEL: { key: Schluessel; text: string }[] = [
  { key: 'flaeche', text: 'Wohnfläche' },
  { key: 'personen', text: 'Personen (Personentage)' },
  { key: 'einheiten', text: 'Wohneinheiten (gleiche Teile)' },
  { key: 'anteil', text: 'Fester Anteil je Wohnung' },
  { key: 'verbrauch', text: 'Verbrauch (Haupt- und Unterzähler)' },
  { key: 'direkt', text: 'Direkt einer Wohnung zugeordnet' },
];
export type GemeinsamSchluessel = 'flaeche' | 'personen' | 'einheiten';
export const GEMEINSAM: { key: GemeinsamSchluessel; text: string }[] = [
  { key: 'flaeche', text: 'nach Wohnfläche (m²)' },
  { key: 'personen', text: 'nach Personen' },
  { key: 'einheiten', text: 'zu gleichen Teilen je Wohnung' },
];

export interface Einheit { id: number; kuerzel: string; bezeichnung: string; flaeche: number; personen: number; eigennutzung: boolean; sort: number }
export interface Kondition { id: number; gueltig_ab: string; kaltmiete: number; nk_abschlag: number }
export interface Vertrag {
  id: number; nummer: string; einheit_id: number; einheit: string; name: string; email: string | null; telefon: string | null; anschrift: string | null;
  beginn: string; ende: string | null; personen: number; notiz: string | null; konditionen: Kondition[];
}
export interface Kostenart { id: number; bezeichnung: string; umlagefaehig: boolean; schluessel: Schluessel; zaehler_id: number | null; grundanteil: number; rest_einheit_id: number | null; gemeinsam_schluessel: GemeinsamSchluessel; anteile: Record<number, number>; p35a: boolean; sort: number; aktiv: boolean }
export interface Ablesung { id: number; datum: string; stand: number; notiz: string | null }
export interface Zaehler { id: number; bezeichnung: string; nummer: string | null; art: string; masseinheit: string; einheit_id: number | null; haupt_id: number | null; aktiv: boolean; ablesungen: Ablesung[] }

/** aktuelle Kondition eines Mietverhältnisses */
export const aktuell = (v: Vertrag, stichtag = heute()) =>
  [...v.konditionen].filter((k) => k.gueltig_ab <= stichtag).sort((a, b) => b.gueltig_ab.localeCompare(a.gueltig_ab))[0] ?? v.konditionen[0];

export const jahre = () => { const j = new Date().getFullYear(); return [j + 1, j, j - 1, j - 2, j - 3, j - 4]; };

export function JahrAuswahl({ jahr, onChange }: { jahr: number; onChange: (j: number) => void }) {
  return (
    <Select style={{ width: '7rem' }} onChange={(e) => onChange(Number((e.detail.selectedOption as HTMLElement).dataset.j))}>
      {jahre().map((j) => <Option key={j} data-j={j} selected={j === jahr}>{j}</Option>)}
    </Select>
  );
}

export function DatumFeld({ label, value, onChange, required }: { label: string; value: string | null; onChange: (v: string) => void; required?: boolean }) {
  return (
    <FieldBox label={label} required={required}>
      <DatePicker formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={value ?? ''} style={{ width: '100%' }} onChange={(e) => onChange(e.detail.value)} />
    </FieldBox>
  );
}

export function ZahlFeld({ label, value, onChange, required, einheit = '€' }: { label: string; value: string; onChange: (v: string) => void; required?: boolean; einheit?: string }) {
  return (
    <FieldBox label={`${label}${einheit ? ` (${einheit})` : ''}`} required={required}>
      <Input style={{ width: '100%', textAlign: 'right' }} value={value} data-kein-autofill onInput={(e) => onChange(e.target.value)} />
    </FieldBox>
  );
}

/** Auswahlliste; leer = „(keine)“, wenn `leer` gesetzt ist */
export function AuswahlFeld<T extends string | number>({ label, value, optionen, onChange, leer, required }: {
  label: string; value: T | null; optionen: { key: T; text: string }[]; onChange: (v: T | null) => void; leer?: string; required?: boolean;
}) {
  return (
    <FieldBox label={label} required={required}>
      <Select style={{ width: '100%' }} onChange={(e) => {
        const k = (e.detail.selectedOption as HTMLElement).dataset.k ?? '';
        const o = optionen.find((x) => String(x.key) === k);
        onChange(o ? o.key : null);
      }}>
        {leer !== undefined && <Option data-k="" selected={value === null}>{leer}</Option>}
        {optionen.map((o) => <Option key={String(o.key)} data-k={String(o.key)} selected={o.key === value}>{o.text}</Option>)}
      </Select>
    </FieldBox>
  );
}

const zelle = { padding: '0.4rem 0.6rem', borderBottom: '1px solid var(--sapList_BorderColor)', textAlign: 'left' as const, verticalAlign: 'top' as const };
export interface Spalte<T> { titel: string; wert: (z: T) => ReactNode; rechts?: boolean; summe?: (zeilen: T[]) => ReactNode; /** nicht umbrechen (z. B. Datum, Monat) */ fest?: boolean }

/** schlichte Tabelle mit fixiertem Kopf (portal-tabrahmen), Beträge rechtsbündig, optional Summenzeile */
export function Tabelle<T>({ spalten, zeilen, leer = 'Keine Einträge', onZeile, schluessel }: {
  spalten: Spalte<T>[]; zeilen: T[]; leer?: string; onZeile?: (z: T) => void; schluessel: (z: T) => string | number;
}) {
  if (!zeilen.length) return <div className="portal-empty">{leer}</div>;
  const mitSumme = spalten.some((s) => s.summe);
  return (
    <div className="portal-tabrahmen">
      <table style={{ borderCollapse: 'collapse', width: '100%' }}>
        <thead><tr>{spalten.map((s) => <th key={s.titel} style={{ ...zelle, textAlign: s.rechts ? 'right' : 'left', whiteSpace: 'nowrap' }}>{s.titel}</th>)}</tr></thead>
        <tbody>
          {zeilen.map((z) => (
            <tr key={schluessel(z)} onClick={onZeile ? () => onZeile(z) : undefined} style={{ cursor: onZeile ? 'pointer' : undefined }}>
              {spalten.map((s) => <td key={s.titel} style={{ ...zelle, textAlign: s.rechts ? 'right' : 'left', whiteSpace: s.rechts || s.fest ? 'nowrap' : undefined }}>{s.wert(z)}</td>)}
            </tr>
          ))}
        </tbody>
        {mitSumme && (
          <tfoot><tr>{spalten.map((s) => <td key={s.titel} style={{ ...zelle, fontWeight: 'bold', textAlign: s.rechts ? 'right' : 'left', whiteSpace: 'nowrap' }}>{s.summe?.(zeilen) ?? ''}</td>)}</tr></tfoot>
        )}
      </table>
    </div>
  );
}

export const summe = <T,>(f: (z: T) => number) => (zeilen: T[]) => eur(zeilen.reduce((s, z) => s + f(z), 0));
