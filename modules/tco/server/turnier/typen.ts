/**
 * Turniere (Sport → Turniere): gemeinsame Typen aller drei Modi. Wird auch von der Oberfläche importiert
 * (modules/tco/web/turnier/…) – deshalb ohne Server-Abhängigkeiten.
 */

export type Modus = 'ko' | 'liga' | 'spass';
export type TurnierStatus = 'entwurf' | 'anmeldung' | 'laeuft' | 'beendet';
export type Wertung = 'offen' | 'gespielt' | 'aufgabe' | 'wo' | 'keine' | 'freilos';
export type Seite = 'a' | 'b';
/** Satz als [Spiele Seite a, Spiele Seite b]; Match-Tiebreak als [Punkte a, Punkte b] */
export type Satz = [number, number];

export const MODUS_TEXT: Record<Modus, string> = {
  ko: 'KO-Turnier mit Nebenrunde',
  liga: 'Monats-Gruppenliga',
  spass: 'Doppel-/Mixed-Spaßturnier',
};
export const STATUS_TEXT: Record<TurnierStatus, string> = {
  entwurf: 'Entwurf', anmeldung: 'Anmeldung offen', laeuft: 'läuft', beendet: 'beendet',
};

/** KO: Nebenrunde nur für Verlierer der 1. Runde (inkl. Freilos-Verlierer der 2. Runde) oder für alle Ausgeschiedenen */
export interface KoEinstellungen {
  nebenrunde: 'keine' | 'erste_runde' | 'alle';
  /** Stärke aus LK oder aus dem manuellen Rang */
  setzung: 'lk' | 'manuell';
  /** Anzahl Gesetzte (0, 2, 4, 8, 16); Rest wird gelost */
  gesetzte: number;
}
/** Liga: Gruppengröße 4 oder 5, erster Monat, Anzahl Runden (Monate) */
export interface LigaEinstellungen {
  gruppengroesse: 4 | 5;
  setzung: 'lk' | 'manuell';
  /** erster Monat JJJJ-MM */
  start: string;
  runden: number;
}
/** Spaßturnier: Plätze, Minuten je Runde, Anzahl Runden (0 = offen) */
export interface SpassEinstellungen {
  plaetze: number;
  minuten: number;
  runden: number;
}
export type Einstellungen = KoEinstellungen | LigaEinstellungen | SpassEinstellungen;

export const STANDARD_EINSTELLUNGEN: { ko: KoEinstellungen; liga: LigaEinstellungen; spass: SpassEinstellungen } = {
  ko: { nebenrunde: 'erste_runde', setzung: 'lk', gesetzte: 4 },
  liga: { gruppengroesse: 4, setzung: 'lk', start: '', runden: 6 },
  spass: { plaetze: 4, minuten: 20, runden: 6 },
};

export interface Turnier {
  id: number;
  kennung: string;
  name: string;
  modus: Modus;
  status: TurnierStatus;
  beschreibung: string | null;
  meldeschluss: string | null;
  max_teilnehmer: number | null;
  einstellungen: Record<string, unknown>;
}

export interface Teilnehmer {
  id: number;
  turnier_id: number;
  vorname: string;
  nachname: string;
  geburtsjahr: number | null;
  geschlecht: 'w' | 'm' | 'd' | null;
  email: string | null;
  telefon: string | null;
  adrnr: string | null;
  lk: number | null;
  rang: number | null;
  setzplatz: number | null;
  status: 'gemeldet' | 'warteliste' | 'abgemeldet';
  bemerkung: string | null;
  angemeldet_am: string;
}

export interface Spiel {
  id: number;
  turnier_id: number;
  runde_id: number | null;
  feld: 'haupt' | 'neben' | 'gruppe' | 'runde';
  runde: number;
  pos: number;
  gruppe: number | null;
  platz: number | null;
  a: number[];
  b: number[];
  saetze: Satz[] | null;
  wertung: Wertung;
  sieger: Seite | 'x' | null;
  /** Liga: wer sich um einen Termin bemüht hat ('beide' ab Migration 100_turnier_liga) */
  bemueht: Seite | 'beide' | null;
  eingetragen_von: string | null;
  eingetragen_am: string | null;
}

export interface Runde {
  id: number;
  turnier_id: number;
  nr: number;
  monat: string | null;
  beginn: string | null;
  minuten: number | null;
  status: 'geplant' | 'laeuft' | 'abgeschlossen';
}

/** Anzeigename „Vorname N.“ (öffentliche Seiten) */
export const kurzname = (t: Pick<Teilnehmer, 'vorname' | 'nachname'>) => `${t.vorname} ${t.nachname.slice(0, 1)}.`.trim();
export const vollname = (t: Pick<Teilnehmer, 'vorname' | 'nachname'>) => `${t.vorname} ${t.nachname}`.trim();
