import { useMemo, useState, type ReactNode } from 'react';
import { Button, ObjectStatus } from '@ui5/webcomponents-react';
import { toast } from '@core/toast';
import type { Fund, Stufe, Typ } from '../server/typen';

export const W = '/api/m/wca';

// ---------------------------------------------------------------------------------------------- Formate (de-DE)

/** Stunden/Zahlen: de-DE, höchstens zwei Nachkommastellen */
export const zahl = (v: number | null | undefined) => (v ?? 0).toLocaleString('de-DE', { maximumFractionDigits: 2 });
export const std = (v: number | null | undefined) => `${zahl(v)} h`;
/** Anteil 0..1 als ganze Prozent („86 %“); null → „–“ */
export const proz = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? '–' : `${Math.round(v * 100)} %`);
export const quote = (b: number, rest: number) => (b + rest > 0 ? b / (b + rest) : null);

const WT = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
/** 0 = Mo … 6 = So */
export const wochentagNr = (iso: string) => (new Date(`${iso.slice(0, 10)}T12:00:00Z`).getUTCDay() + 6) % 7;
export const wt = (iso: string) => WT[wochentagNr(iso)];
export const WOCHENTAGE = WT;
/** TT.MM. */
export const tm = (iso: string | null | undefined) => (iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.` : '');
/** TT.MM.JJJJ */
export const dat = (iso: string | null | undefined) => (iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : '');
/** „Mo 16.11.“ */
export const wtm = (iso: string | null | undefined) => (iso ? `${wt(iso)} ${tm(iso)}` : '');
export const arbeitstageText = (tage: number[] | null | undefined) => (tage?.length ? [...tage].sort().map((t) => WT[t]).join(', ') : '');
/** Zahl aus einer Eingabe mit Komma oder Punkt; leer → null */
export function eingabeZahl(s: string): number | null {
  const t = s.trim();
  if (!t) return null;
  const n = Number(t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t);
  return Number.isFinite(n) ? n : null;
}
export const zahlEingabe = (v: number | null | undefined) => (v === null || v === undefined ? '' : String(v).replace('.', ','));

// ---------------------------------------------------------------------------------------------- Stufen, Typen

export const STUFEN: { key: Stufe; text: string }[] = [{ key: 1, text: 'Niedrig' }, { key: 2, text: 'Mittel' }, { key: 3, text: 'Hoch' }];
export const stufeText = (s: Stufe) => STUFEN.find((x) => x.key === s)?.text ?? String(s);
export const stufeState = (s: Stufe) => (s === 3 ? 'Negative' : s === 2 ? 'Critical' : 'Information') as 'Negative' | 'Critical' | 'Information';
export function StufeStatus({ stufe }: { stufe: Stufe }) {
  return <ObjectStatus state={stufeState(stufe)} showDefaultIcon>{stufeText(stufe)}</ObjectStatus>;
}
export const TYPEN: Record<Typ, string> = { B: 'Billable', P: 'PreSales', I: 'Intern', A: 'Abwesenheit' };
export const ARTEN: Record<string, string> = { ko: 'Kontierung', pl: 'Plausibilität', ns: 'Nichtssagend', fr: 'Fragwürdig', re: 'Regelwerk' };
export const KATEGORIEN: Record<string, string> = { K: 'Kontierung', P: 'Plausibilität', T: 'Texte', R: 'Regelwerk' };

/** Funde sortiert: Stufe absteigend, dann Tag */
export const fundSort = (a: Fund, b: Fund) => b.stufe - a.stufe || (a.tag ?? '').localeCompare(b.tag ?? '');

// ---------------------------------------------------------------------------------------------- Zwischenablage, TSV

export async function kopieren(text: string, meldung = 'In die Zwischenablage kopiert') {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // ohne Clipboard-API (z. B. http): über ein unsichtbares Textfeld
    const t = document.createElement('textarea');
    t.value = text;
    t.style.position = 'fixed';
    t.style.opacity = '0';
    document.body.appendChild(t);
    t.select();
    document.execCommand('copy');
    t.remove();
  }
  toast(meldung);
}

/** Tabelle als TSV (Tabulator, Dezimalkomma) – zum Einfügen in Excel */
export function tsv(kopf: string[], zeilen: (string | number | null | undefined)[][]): string {
  const zelle = (v: string | number | null | undefined) =>
    typeof v === 'number' ? String(Math.round(v * 100) / 100).replace('.', ',') : String(v ?? '').replace(/[\t\r\n]+/g, ' ');
  return [kopf, ...zeilen].map((z) => z.map(zelle).join('\t')).join('\n');
}

// ---------------------------------------------------------------------------------------------- Bausteine

/** Kennzahl-Kachel der Übersicht */
export function Kachel({ titel, wert, state = 'None', text, children, onClick }: {
  titel: string; wert: ReactNode; state?: 'None' | 'Positive' | 'Negative' | 'Critical'; text?: ReactNode; children?: ReactNode; onClick?: () => void;
}) {
  return (
    <div className={`portal-wca-kachel${onClick ? ' portal-wca-kachel--klick' : ''}`} onClick={onClick} role={onClick ? 'button' : undefined} tabIndex={onClick ? 0 : undefined}
         onKeyDown={onClick ? (e) => { if (e.key === 'Enter') onClick(); } : undefined}>
      <div className="portal-wca-kachel__titel">{titel}</div>
      <div className={`portal-kpi__value portal-kpi__value--${state}`}>{wert}</div>
      {text && <div className="portal-muted portal-small">{text}</div>}
      {children}
    </div>
  );
}
export function Kacheln({ children }: { children: ReactNode }) {
  return <div className="portal-wca-kacheln">{children}</div>;
}

/** Verteilung Billable / PreSales / Intern / Abwesenheit als gestapelter Balken */
export function Verteilung({ B, P, I, A }: { B: number; P: number; I: number; A: number }) {
  const summe = B + P + I + A;
  if (summe <= 0) return null;
  const teile: [Typ, number][] = [['B', B], ['P', P], ['I', I], ['A', A]];
  return (
    <span className="portal-wca-balken" title={teile.map(([t, v]) => `${TYPEN[t]} ${std(v)}`).join(' · ')}>
      {teile.filter(([, v]) => v > 0).map(([t, v]) => <span key={t} className={`portal-wca-balken__${t}`} style={{ width: `${(v / summe) * 100}%` }} />)}
    </span>
  );
}
export function VerteilungLegende() {
  return (
    <span className="portal-wca-legende portal-small portal-muted">
      {(['B', 'P', 'I', 'A'] as Typ[]).map((t) => <span key={t}><span className={`portal-wca-punkt portal-wca-balken__${t}`} />{TYPEN[t]}</span>)}
    </span>
  );
}

/** kleine Markierung hinter einem Namen („bis 13.11.“, „Teamwechsel“) */
export function Pill({ children, state = 'None' }: { children: ReactNode; state?: 'None' | 'Information' | 'Critical' | 'Negative' | 'Positive' }) {
  return <ObjectStatus inverted state={state} className="portal-wca-pill">{children}</ObjectStatus>;
}

// ---------------------------------------------------------------------------------------------- Tabelle

export interface Spalte<T> {
  titel: string;
  wert: (z: T) => ReactNode;
  rechts?: boolean;
  /** Sortierschlüssel – mit ihm lässt sich die Spalte über den Kopf sortieren */
  sort?: (z: T) => number | string;
  summe?: (zeilen: T[]) => ReactNode;
  /** nicht umbrechen */
  fest?: boolean;
  /** Text darf umbrechen und braucht Platz (z. B. Rückmeldetext) */
  breit?: boolean;
  tooltip?: string;
}

/**
 * HTML-Tabelle im Rollrahmen (fixierter Kopf): sortierbar über den Spaltenkopf, optional mit Gruppenzeilen
 * (Zeilen bleiben in der Reihenfolge ihrer Gruppen), aufklappbarer Detailzeile, Summenzeile und Begrenzung („Weitere anzeigen“).
 */
export function Tabelle<T>({ spalten, zeilen, schluessel, leer = 'Keine Einträge', gruppe, gruppenKopf, detail, aufgeklappt, onZeile, sortierung, max, klein }: {
  spalten: Spalte<T>[];
  zeilen: T[];
  schluessel: (z: T) => string;
  leer?: string;
  gruppe?: (z: T) => string;
  gruppenKopf?: (gruppe: string, zeilen: T[]) => ReactNode;
  /** Inhalt der aufgeklappten Zeile; Klick auf die Zeile klappt auf und zu */
  detail?: (z: T) => ReactNode;
  /** von außen aufgeklappte Zeilen (Schlüssel) */
  aufgeklappt?: string[];
  onZeile?: (z: T) => void;
  sortierung?: { titel: string; ab?: boolean };
  max?: number;
  klein?: boolean;
}) {
  const [sort, setSort] = useState(sortierung ?? null);
  const [offen, setOffen] = useState<Set<string>>(new Set());
  const [grenze, setGrenze] = useState(max ?? Infinity);

  const sortiert = useMemo(() => {
    const liste = [...zeilen];
    const f = spalten.find((s) => s.titel === sort?.titel)?.sort;
    if (f) {
      liste.sort((a, b) => {
        const va = f(a), vb = f(b);
        const c = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb), 'de');
        return sort?.ab ? -c : c;
      });
    }
    if (gruppe) {
      const rang = new Map<string, number>();
      for (const z of zeilen) { const g = gruppe(z); if (!rang.has(g)) rang.set(g, rang.size); }
      liste.sort((a, b) => rang.get(gruppe(a))! - rang.get(gruppe(b))!);
    }
    return liste;
  }, [zeilen, sort, spalten, gruppe]);

  if (!zeilen.length) return <div className="portal-empty">{leer}</div>;
  const sichtbar = sortiert.slice(0, grenze);
  const mitSumme = spalten.some((s) => s.summe);
  const extern = new Set(aufgeklappt ?? []);
  const umschalten = (k: string) => setOffen((o) => { const n = new Set(o); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const kopfKlick = (s: Spalte<T>) => s.sort && setSort((alt) => ({ titel: s.titel, ab: alt?.titel === s.titel ? !alt.ab : typeof s.sort!(zeilen[0]) === 'number' }));

  const zeilenHtml: ReactNode[] = [];
  let letzte: string | null = null;
  for (const z of sichtbar) {
    const k = schluessel(z);
    if (gruppe) {
      const g = gruppe(z);
      if (g !== letzte) {
        letzte = g;
        zeilenHtml.push(
          <tr key={`g:${g}`} className="portal-wca-gruppe">
            <td colSpan={spalten.length}>{gruppenKopf ? gruppenKopf(g, sortiert.filter((x) => gruppe(x) === g)) : g}</td>
          </tr>,
        );
      }
    }
    const istOffen = !!detail && (offen.has(k) !== extern.has(k));
    const klick = detail ? () => umschalten(k) : onZeile ? () => onZeile(z) : undefined;
    zeilenHtml.push(
      <tr key={k} onClick={klick} className={`${klick ? 'portal-wca-klick' : ''}${istOffen ? ' portal-wca-offen' : ''}`}>
        {spalten.map((s) => (
          <td key={s.titel} className={`${s.rechts ? 'portal-wca-rechts' : ''}${s.fest || s.rechts ? ' portal-nowrap' : ''}${s.breit ? ' portal-wca-breit' : ''}`}>{s.wert(z)}</td>
        ))}
      </tr>,
    );
    if (istOffen) {
      zeilenHtml.push(<tr key={`d:${k}`} className="portal-wca-detail"><td colSpan={spalten.length}>{detail!(z)}</td></tr>);
    }
  }

  return (
    <>
      <div className="portal-tabrahmen">
        <table className={`portal-wca-tabelle${klein ? ' portal-wca-tabelle--klein' : ''}`}>
          <thead>
            <tr>
              {spalten.map((s) => (
                <th key={s.titel} title={s.tooltip} className={`${s.rechts ? 'portal-wca-rechts' : ''}${s.sort ? ' portal-wca-klick' : ''}`} onClick={() => kopfKlick(s)}>
                  {s.titel}{sort?.titel === s.titel ? (sort.ab ? ' ▼' : ' ▲') : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>{zeilenHtml}</tbody>
          {mitSumme && (
            <tfoot>
              <tr>{spalten.map((s) => <td key={s.titel} className={`portal-wca-summe${s.rechts ? ' portal-wca-rechts portal-nowrap' : ''}`}>{s.summe?.(zeilen) ?? ''}</td>)}</tr>
            </tfoot>
          )}
        </table>
      </div>
      {sortiert.length > grenze && (
        <div className="portal-row" style={{ padding: '0.5rem 1rem' }}>
          <Button design="Transparent" onClick={() => setGrenze((g) => g + (max ?? 50))}>Weitere anzeigen ({sortiert.length - grenze})</Button>
          <Button design="Transparent" onClick={() => setGrenze(Infinity)}>Alle anzeigen</Button>
        </div>
      )}
    </>
  );
}

/** Summen-Helfer für Tabellenspalten */
export const summe = <T,>(f: (z: T) => number, format: (v: number) => ReactNode = zahl) => (zeilen: T[]) => format(zeilen.reduce((s, z) => s + f(z), 0));
