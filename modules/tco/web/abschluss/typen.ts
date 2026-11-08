import { TCO } from '../util';

export const AB = `${TCO}/abschluss`;

export type Bereich = 'A' | 'B' | 'C' | 'D';
export interface EarKonto { konto: string; name: string; wert: number }
export interface EarBereich { bereich: Bereich; text: string; einnahmen: EarKonto[]; ausgaben: EarKonto[]; ein: number; aus: number; ergebnis: number }
export interface Ear { bereiche: EarBereich[]; ein: number; aus: number; ergebnis: number; leer: boolean }

export interface UebKonto { konto: string; name: string; werte: number[] }
export interface UebArt { art: '1' | '2'; text: 'Einnahmen' | 'Ausgaben'; konten: UebKonto[]; summe: number[] }
export interface UebBereich { bereich: Bereich; text: string; ein: number[]; aus: number[]; ergebnis: number[] }
export interface Ueberschuss { jahre: number[]; arten: UebArt[]; bereiche: UebBereich[]; ein: number[]; aus: number[]; ergebnis: number[] }

export interface Bankbestand { jahr: number; konto: string; name: string; kennzahl: string; anfang: number; ende: number; delta: number; quelle: string }

export type AnlStatus = 'Zugang' | 'abgeschrieben' | 'letzte AfA' | 'aktiv';
export interface Spiegel {
  anlnr: number; bezeichnung: string; anschdat: string; anschwert: number; nutzdauer: number; monate_ej: number;
  afa_satz: number; afa_voll: number; bw_beginn: number; zugang: number; afa_jahr: number; bw_ende: number; ende_jahr: number | null; status: AnlStatus;
}
export interface SpiegelSumme { anschwert: number; bw_beginn: number; zugang: number; afa_jahr: number; bw_ende: number }
export interface Anlage {
  anlnr: number; bezeichnung: string; anschdat: string; anschwert: number; nutzdauer: number; monate_ej: number; notiz: string | null;
}

export interface Abschluss {
  jahr: number; jahre: number[]; ear: Ear; ueberschuss: Ueberschuss; bank: Bankbestand[];
  anlagen: { spiegel: Spiegel[]; summe: SpiegelSumme; leer: boolean }; hinweise: string[]; paperless: boolean;
}

export type State = 'None' | 'Positive' | 'Negative' | 'Critical' | 'Information';
export const ANL_STATE: Record<AnlStatus, State> = { Zugang: 'Information', 'letzte AfA': 'Critical', aktiv: 'Positive', abgeschrieben: 'None' };
export const saldoState = (v: number): State => (v < 0 ? 'Negative' : 'Positive');
export const anlnrText = (n: number) => String(n).padStart(4, '0');
