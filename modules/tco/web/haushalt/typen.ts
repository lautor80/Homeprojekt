import { TCO } from '../util';

/** Typen der App „Haushaltsplan“ – Gegenstück zu modules/tco/server/haushalt/logik.ts */
export const HH = `${TCO}/haushalt`;

export type State = 'None' | 'Positive' | 'Negative' | 'Critical' | 'Information';
export type Methode = 'HOCH' | 'AVG3' | 'MED5' | 'TREND' | 'FACH' | 'MANUELL';
export type RechenMethode = 'HOCH' | 'AVG3' | 'MED5' | 'TREND';
export type Status = 'ENTWURF' | 'BESCHLOSSEN' | 'GENEHMIGT';
export const RECHEN_METHODEN: RechenMethode[] = ['HOCH', 'AVG3', 'MED5', 'TREND'];
export const STATUS_STATE: Record<Status, State> = { ENTWURF: 'Information', BESCHLOSSEN: 'Positive', GENEHMIGT: 'Positive' };
export const MON = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
export const MONATE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

export interface Cfg {
  toleranz_gelb: number; toleranz_rot: number; mindestreserve: number | null; ausreisser_prozent: number;
  grundlage_ab: number | null; preissteigerung: number; genehmigung_mv: boolean;
}
export interface PlanKopf {
  id: number; jahr: number; fassung: number; status: Status; status_text: string; begruendung: string | null;
  beschlossen_am: string | null; beschlossen_von: string | null; genehmigt_am: string | null; genehmigt_von: string | null;
  preissteigerung: number; mindestreserve: number | null; tilgung: number | null; anfangsbestand: number | null;
  stand: string | null; notiz: string | null; paperless_id: number | null;
}
export interface Hochrechnung { wert: number; art: 'IST' | 'VERLAUF' | 'REST' | 'LINEAR'; anteil: number }
export interface Grundlage {
  ist: Record<number, number>; ist_stand: number; ist_basis: number;
  sonder: { jahr: number; grund: string }[]; zaehlt: number[];
  werte: Record<RechenMethode, number | null>; treffer: Record<RechenMethode, number | null>; pruefjahre: number[];
  hoch: Hochrechnung | null; fach: number | null; beste: Methode; wenig_historie: boolean; jahre_anzahl: number;
  ausreisser: { jahr: number; wert: number; median: number; abweichung: number }[];
  vorgaenger: { konto: string; ab_jahr: number } | null;
}
export interface Position {
  konto: string; name: string; art: 'E' | 'A'; bereich: string; bereich_text: string;
  methode: Methode; methode_text: string; vorschlag: number | null; planwert: number; zuschlag: number | null; notiz: string | null; manuell: boolean;
  monate: number[]; monate_fest: boolean; monate_von_hand: boolean; grundlage: Grundlage | null;
}
export interface Vorhaben { id: number; bezeichnung: string; art: 'E' | 'A'; monat: number; betrag: number; konto: string | null; projekt: string | null; eingeplant: boolean }
export interface PlanProjekt {
  id: number; bezeichnung: string; projektnr: string | null; status: 'IDEE' | 'BEANTRAGT' | 'GENEHMIGT' | 'ABGELEHNT' | 'ZURUECKGESTELLT' | 'UMSETZUNG' | 'ABGESCHLOSSEN'; status_text: string;
  beginn: string; ende: string; einrechnen: boolean; vorgabe: boolean; gewaehlt: boolean; fest: boolean;
  wirkung: { einnahmen: number[]; ausgaben: number[]; darlehen: number[]; tilgung: number[]; sum: { einnahmen: number; ausgaben: number; ergebnis: number; darlehen: number; tilgung: number; liquiditaet: number } };
  beitrag: { ergebnis: number; jahresende: number; tiefster: number };
}
export interface ProjektSollIst {
  id: number; bezeichnung: string; projektnr: string | null; status: PlanProjekt['status']; status_text: string; beginn: string; ende: string;
  budget: number; ist: number; einnahmen_plan: number; einnahmen_ist: number; plan_jahr: number; ist_jahr: number; bewertung: Bewertung;
}
export interface LiqMonat { monat: number; einnahmen: number; ausgaben: number; tilgung: number; bestand: number; ausreichend: boolean | null }
export interface PlanSicht {
  plan: PlanKopf; aenderbar: boolean; basisjahr: number; stand_monat: number; stand_text: string; jahre: number[];
  positionen: Position[]; vorhaben: Vorhaben[]; projekte: PlanProjekt[];
  /** einnahmen/ausgaben/ergebnis MIT den eingerechneten Projekten; `ohne` = ohne Projekte */
  summen: {
    einnahmen: number; ausgaben: number; ergebnis: number; vorhaben_e: number; vorhaben_a: number; basis_e: number; basis_a: number; projekte_e: number; projekte_a: number;
    ohne: { einnahmen: number; ausgaben: number; ergebnis: number; tiefster: number; tiefsterMonat: number; jahresende: number };
  };
  bereiche: { bereich: string; text: string; einnahmen: number; ausgaben: number; ergebnis: number }[];
  liquiditaet: {
    anfang: number; monate: LiqMonat[]; tiefster: number; tiefsterMonat: number; mindestreserve: number | null;
    tilgung: { monate: number[]; summe: number; quelle: 'PLAN' | 'DARLEHEN' | 'KEINE'; hinweis: string | null };
    anfang_herkunft: { betrag: number; quelle: string; text: string }; ist: (number | null)[];
  };
  hinweise: string[]; fassungen: PlanKopf[]; cfg: Cfg; fehlende: { konto: string; name: string }[];
}
export interface Init {
  plaene: PlanKopf[]; jahr: number; jahre: number[]; cfg: Cfg; konten: { konto: string; name: string; art: 'E' | 'A' }[];
  methoden: Record<Methode, string>; paperless: boolean; ueberwachung: boolean;
}
export interface Bewertung { abweichung: number; prozent: number | null; stufe: 'IM_PLAN' | 'BEOBACHTEN' | 'UEBERSCHRITTEN'; state: State; text: string }
export interface SollIstZeile {
  konto: string; name: string; art: 'E' | 'A'; bereich: string; bereich_text: string;
  plan: number; ist: number; projekt: number; hochrechnung: number; hoch_art: string; geplant: boolean; bewertung: Bewertung;
}
export interface SollIst {
  jahr: number; plan: PlanKopf | null; vorlaeufig: boolean; stand_monat: number; stand_text: string; zeilen: SollIstZeile[];
  summen: Record<'E' | 'A', { plan: number; ist: number; hochrechnung: number; bewertung: Bewertung }>;
  ergebnis: { plan: number; ist: number; hochrechnung: number };
  verlauf: Record<'E' | 'A', { plan: number[]; ist: (number | null)[] }>;
  ueberschritten: number; beobachten: number; projekte: ProjektSollIst[]; cfg: Cfg;
}

/** Betrag ohne Nachkommastellen (Planwerte sind auf 10 € gerundet), Prozent mit Vorzeichen */
export const euro = (v: number | null | undefined) => (v === null || v === undefined ? '–' : `${Math.round(v).toLocaleString('de-DE')} €`);
export const prozent = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? '–' : `${v > 0 ? '+' : ''}${v.toLocaleString('de-DE', { maximumFractionDigits: 1 })} %`);
/** Eingabe in deutscher Schreibweise („1.234,56“, „5.000“) – leer = null, ungültig = NaN */
export function zahlLesen(s: string): number | null {
  const t = s.trim().replace(/\s|€/g, '');
  if (!t) return null;
  return Number(t.includes(',') || /^-?\d{1,3}(\.\d{3})+$/.test(t) ? t.replace(/\./g, '').replace(',', '.') : t);
}
export const zahlText = (v: number | null | undefined) => (v === null || v === undefined ? '' : v.toLocaleString('de-DE', { maximumFractionDigits: 2 }));
