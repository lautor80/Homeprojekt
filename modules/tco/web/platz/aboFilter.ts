/**
 * Platzverwaltung → Abos: Schnellfilter der Abo-Tabelle (Suche, Status, Herkunft, Platz, Abrechnung) – reine Funktionen ohne React.
 * Der Filter ist ein einfaches JSON-Objekt und wandert so in die Ansichtsvariante (Varianten.tsx, repid `tco.platzverwaltung.abos`).
 * Test: server/test/tco_abo_filter.test.ts
 */

export type AboStatus = 'alle' | 'laufend' | 'beendet';
export type AboHerkunft = 'alle' | 'Portal' | 'EP3';
export type AboAbrechnung = 'alle' | 'abgerechnet' | 'offen';

export interface AboFilter {
  /** Suche in Mitglied, Abo-Nr. und Notiz (alle Wörter müssen vorkommen) */
  suche: string;
  /** laufend = noch kommende Termine, beendet = keine mehr */
  status: AboStatus;
  herkunft: AboHerkunft;
  /** Name des Platzes, leer = alle */
  platz: string;
  abrechnung: AboAbrechnung;
}

/** die Felder einer Abo-Zeile, nach denen gefiltert wird */
export interface AboFilterZeile {
  bid: string; kunde: string; platz: string; text: string | null; kommend: number; abgerechnet: number; quelle: string;
}

export const LEERER_ABO_FILTER: AboFilter = { suche: '', status: 'alle', herkunft: 'alle', platz: '', abrechnung: 'alle' };

const STATUS: AboStatus[] = ['alle', 'laufend', 'beendet'];
const HERKUNFT: AboHerkunft[] = ['alle', 'Portal', 'EP3'];
const ABRECHNUNG: AboAbrechnung[] = ['alle', 'abgerechnet', 'offen'];

/** Filter aus einer gespeicherten Variante lesen: Unbekanntes oder Falsches fällt still auf die Vorgabe zurück */
export function aboFilterLesen(wert: unknown): AboFilter {
  const o = (wert && typeof wert === 'object' && !Array.isArray(wert) ? wert : {}) as Record<string, unknown>;
  const aus = <T extends string>(v: unknown, erlaubt: T[], vorgabe: T): T => (typeof v === 'string' && (erlaubt as string[]).includes(v) ? v as T : vorgabe);
  return {
    suche: typeof o.suche === 'string' ? o.suche : '',
    status: aus(o.status, STATUS, 'alle'),
    herkunft: aus(o.herkunft, HERKUNFT, 'alle'),
    platz: typeof o.platz === 'string' ? o.platz : '',
    abrechnung: aus(o.abrechnung, ABRECHNUNG, 'alle'),
  };
}

/** ist irgendein Schnellfilter gesetzt? */
export function aboFilterAktiv(f: AboFilter): boolean {
  return !!f.suche.trim() || f.status !== 'alle' || f.herkunft !== 'alle' || !!f.platz || f.abrechnung !== 'alle';
}

/** Abos nach den Schnellfiltern auswählen (Reihenfolge bleibt) */
export function abosFiltern<T extends AboFilterZeile>(abos: T[], f: AboFilter): T[] {
  const woerter = f.suche.toLowerCase().split(/\s+/).filter(Boolean);
  return abos.filter((a) => {
    if (f.status === 'laufend' && !(a.kommend > 0)) return false;
    if (f.status === 'beendet' && a.kommend > 0) return false;
    if (f.herkunft !== 'alle' && a.quelle !== f.herkunft) return false;
    if (f.platz && a.platz !== f.platz) return false;
    if (f.abrechnung === 'abgerechnet' && !a.abgerechnet) return false;
    if (f.abrechnung === 'offen' && a.abgerechnet) return false;
    if (woerter.length) {
      const text = `${a.kunde} ${a.bid} ${a.text ?? ''}`.toLowerCase();
      if (!woerter.every((w) => text.includes(w))) return false;
    }
    return true;
  });
}

/** Plätze für die Auswahl: alle in den Daten vorkommenden, sortiert; ein gewählter, der nicht (mehr) vorkommt, bleibt wählbar */
export function aboPlaetze(abos: { platz: string }[], gewaehlt = ''): string[] {
  const s = new Set(abos.map((a) => a.platz).filter(Boolean));
  if (gewaehlt) s.add(gewaehlt);
  return [...s].sort((a, b) => a.localeCompare(b, 'de', { numeric: true }));
}

/** Titelzeile: „Abos (40)“, bei aktivem Filter „Abos (12 von 40)“ */
export function aboTitel(angezeigt: number, gesamt: number, gefiltert: boolean): string {
  return gefiltert ? `Abos (${angezeigt} von ${gesamt})` : `Abos (${gesamt})`;
}
