import { TCO } from '../util';

/** API-Basis der Vereinsübersicht */
export const DASH = `${TCO}/dashboard`;

export type State = 'Positive' | 'Critical' | 'Negative' | 'None';
export type Trend = 'Up' | 'Down' | 'None';

export interface Kpi {
  key: string; title: string; subtitle: string; value: string; unit: string; delta?: string;
  trend: Trend; state: State; details: string; icon: string; display?: 'TILE' | 'CARD'; hasDetail: boolean; todo: boolean;
  /** Auswahl in der Kachel (z. B. Zeitraum Monat/Saison/Jahr) und die gewählte Variante */
  varianten?: KeyText[]; variante?: string;
}
export interface Bereich { key: string; title: string; kpis: Kpi[] }
export interface KeyText { key: string; text: string }

export interface Point { label: string; val1: number; val2: number }
export interface Combo { label: string; val_line: number; bar_pos: number; bar_neg: number }
export interface StackVal { grp: number; bar: string; stack: string; value: number }
export interface Legend { key: string; text: string; kurz?: string; color?: string; hatch?: boolean }
export interface Stacked { groups: string[]; bars: Legend[]; stacks: Legend[]; values: StackVal[]; mainBar: string; title: string; unit: string; emptyText: string }
export interface Verlauf { jahr: number; monat: number; einnahmen: number; ausgaben: number; bestand: number; zukunft: boolean }

export interface Finanzen {
  jahre: KeyText[]; jahreSel: string[]; konten: KeyText[]; kontenSel: string[]; jahreText: string; kontenText: string; mehrjahr: boolean;
  anfangsbestand: number; anfangsjahr: number; einnahmen: number; ausgaben: number; ergebnis: number; kontostand: number; stand: string | null;
  verlauf: Verlauf[];
  liquiditaet: { jahr: number; monat: number; geld: number; forderung: number; ford_stand: string | null; kredit: number; liquiditaet: number };
}

export interface Daten {
  jahr: number; jahre: number[]; heute: string; bereiche: Bereich[];
  charts: {
    mitgliederMonate: { title: string; nameLine: string; namePos: string; nameNeg: string; data: Combo[] };
    mitgliederJahre: { title: string; nameLine: string; namePos: string; nameNeg: string; data: Combo[] };
    clubhaus: { title: string; name1: string; name2: string; data: Point[] };
    finanzen: Finanzen;
    jugend: Stacked & { jahre: KeyText[]; jahreSel: string[]; ansicht: 'GESAMT' | 'TRAINER' };
    halle: Stacked & { jahre: KeyText[]; jahreSel: string[]; jahreVerlauf: { title: string; name1: string; data: Point[] } };
  };
}

export interface DetailZeile { cols: string[]; state: State; adrnr?: string; vertragnr?: string; betrag?: number }
export interface Detail { title: string; head: string[]; info: string; zeilen: DetailZeile[]; mode?: 'BSW'; stichtag?: string; stufen?: KeyText[] }

/** Auswahl der Diagramme (Jahre, Konten, Ansicht) – wird als Query mitgeschickt */
export interface Auswahl { jugJahre: string[]; halJahre: string[]; finJahre: string[]; finKonten: string[]; jugAnsicht: 'GESAMT' | 'TRAINER'; halZeitraum: 'MONAT' | 'SAISON' | 'JAHR' }

/** Kurzform für Achsen wie conv_short: 1,2k / 3,4M, sonst ganze Zahl */
export function kurz(v: number): string {
  const a = Math.abs(v);
  if (a >= 1_000_000) return `${(v / 1_000_000).toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}M`;
  if (a >= 1000) return `${(v / 1000).toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}k`;
  return Math.round(v).toLocaleString('de-DE');
}

/** Stunden wie conv_hours: ganze Zahl ohne Nachkommastellen, sonst ohne überzählige Nullen */
export function std(v: number): string {
  const r = Math.round(v * 100) / 100;
  if (Number.isInteger(r)) return r.toLocaleString('de-DE');
  return r.toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 2 });
}
