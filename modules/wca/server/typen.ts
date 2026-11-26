/**
 * WCA Zeitenkontrolle – gemeinsamer Datenvertrag zwischen Logik (logik/*), Server (index.ts) und Oberfläche (web/*).
 * Reine Typen, keine Laufzeitabhängigkeiten (wird auch von der Oberfläche importiert).
 *
 * Begriffe (siehe docs/wca.md):
 *  - Eintrag / Rückmeldung: eine Blattzeile des Tempo-Exports (Person, Account, Text …) mit ein oder mehreren Tagen.
 *  - Personentag: Summe aller Einträge einer Person an einem Datum.
 *  - Typ: A Abwesenheit, B Billable, P PreSales, I Intern.
 *  - Stichtag: letzter bewerteter Tag.
 */

export type Typ = 'A' | 'B' | 'P' | 'I';
export type Stufe = 1 | 2 | 3; // 1 Niedrig, 2 Mittel, 3 Hoch
export type Kategorie = 'K' | 'P' | 'T' | 'R';
export type Art = 'ko' | 'pl' | 'ns' | 'fr' | 're';

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/** Eintrag direkt aus dem CSV (roh, vor Ableitungen) */
export interface RohEintrag {
  person: string;
  kat: string; // Kategorietyp (Intern / Abrechenbar …)
  proj: string;
  acc: string; // Account roh, z. B. "Servicemanagement|Helioform Services GmbH"
  team: string; // Team roh
  ber: string; // Bereich (Jira-Projekt)
  text: string; // Zeitnachweis / Worklog-Text
  key: string; // Schlüssel, z. B. WDEINT001-37
  zeile: number; // Zeilennummer in der Datei (1 = Kopf)
  tage: [string, number][]; // [ISO-Datum, Stunden], nur Werte ≠ 0, sortiert
}

export interface ImportErgebnis {
  datei: string;
  tage: string[]; // alle Tagesspalten (ISO), sortiert
  eintraege: RohEintrag[];
  accKeys: Record<string, string>; // Account roh → Tempo-Account-Schlüssel
  berKeys: Record<string, string>; // Bereich → Jira-Projektschlüssel
  personen: string[]; // alle Benutzer der Datei (auch ohne Blattzeilen), sortiert
  summen: Record<string, number>; // Kontrollsumme je Person aus der Benutzer-Summenzeile
  hatAccount: boolean;
  hatTeam: boolean;
  hatBereich: boolean;
  warnungen: string[]; // z. B. fehlende Spalten, Kontrollsumme weicht ab
}

/** Antwort von POST /import (Prüflauf und Übernahme) */
export interface ImportAntwort {
  uebernommen: boolean;
  dateien: {
    datei: string;
    fehler?: string; // Datei nicht lesbar → übrige Dateien laufen weiter
    von?: string;
    bis?: string;
    personen: number;
    eintraege: number;
    stunden: number;
    ersetzt: number; // Buchungstage (Person×Datum), die eine ältere Datei ersetzt (bzw. ersetzen würde)
    warnungen: string[];
  }[];
}

export interface ImportZeile {
  id: string;
  datei: string;
  von: string | null;
  bis: string | null;
  personen: number;
  eintraege: number;
  stunden: number;
  importiertAm: string;
  importiertVon: string | null;
}

// ---------------------------------------------------------------------------
// Einstellungen (global, in wca.einstellungen als JSON)
// ---------------------------------------------------------------------------

export interface WortRegel {
  name: string;
  art: 'ns' | 'fr';
  nurAbrechenbar: boolean;
  stufeIntern: Stufe | null; // null = gilt nicht für nicht abrechenbare Einträge
  stufeBillable: Stufe;
  woerter: string; // kommagetrennt; * am Ende = Wortanfang; "re:" = Regex
  tipp: string;
}

export interface Einstellungen {
  toleranz: number; // tol, 0.25 h je Tag
  bundesland: string; // deState, 'BW'
  errorAccounts: string; // zeilenweise
  accountPflichtAb: string; // ISO oder '' = automatisch
  regelwerkAn: boolean;
  regelwerkAb: string; // '2026-11-01'
  regelwerkMinWoerter: number; // 5
  regelwerkIdBillable: boolean;
  regelwerkOhneIdMuster: string; // 'WCMS' – AMS-Tickets: ID am Anfang (R2) nicht nötig
  wiederholungTage: number; // 5 (T6)
  wiederholungMinH: number; // 8 (T6)
  langerTag: number; // 10 (P1)
  langeBuchung: number; // 8 (P2)
  duennH: number; // 4 (T5)
  duennWoerter: number; // 3 (T5)
  aliasse: string; // zeilenweise "Kürzel = Kundenname"
  allgemeinZusatz: string; // weitere Allgemeinbegriffe, kommagetrennt
  regeltermine: string; // kommagetrennt
  feiertage: string; // zeilenweise "Standort JJJJ-MM-TT Name", * = alle
  internMuster: string; // 'W??INT*'
  aus: Record<string, boolean>; // abgeschaltete Regeln (Regel-ID → true)
  wortRegeln: Record<string, WortRegel>; // F_pauschal, F_versuch, …
}

/** Überschreibungen je Person (wca.person) – null = abgeleitet */
export interface PersonVorgabe {
  person: string;
  standort: string | null;
  sollTag: number | null;
  arbeitstage: number[] | null; // 0 = Mo … 6 = So
  von: string | null;
  bis: string | null;
  ausblenden: boolean;
}

// ---------------------------------------------------------------------------
// Auswertung (GET /auswertung)
// ---------------------------------------------------------------------------

export interface Fund {
  regel: string; // K1 … K8, P1 … P3, T1 … T9, T3b, F_*, R1, R2
  kategorie: Kategorie;
  art: Art;
  stufe: Stufe;
  person: string;
  eintrag: number | null; // Index in Auswertung.eintraege, null bei Tagesfund ohne Eintrag (P1, P3)
  tag: string | null; // nur bei Tagesfunden (P1, P2, P3)
  stunden: number; // zählende Stunden im Zeitraum
  meldung: string;
  tipp: string;
  freigebbar: boolean; // nur Funde zu einer Rückmeldung (mit Text) lassen sich freigeben
}

/** Freigabe: Text gilt für Regel und Account als in Ordnung (Tabelle wca.freigabe) */
export interface FreigabeSchluessel {
  regel: string;
  acc: string; // Account roh („Name|Kunde“)
  text: string;
}

export interface Freigabe extends FreigabeSchluessel {
  id: string;
  person: string;
  meldung: string;
  freigegebenVon: string | null;
  freigegebenAm: string;
}

/** Eine Rückmeldung bzw. ein Personentag mit allen Funden (Zeile in den Fundlisten) */
export interface FundGruppe {
  id: string; // 'e<idx>' oder 'd<person>_<tag>'
  person: string;
  team: string;
  eintrag: number | null;
  tag: string | null;
  stufe: Stufe; // Maximum
  stunden: number;
  funde: Fund[];
}

export interface AuswEintrag {
  person: string;
  team: string; // gekürzt, z. B. "Cloud Purchasing"
  typ: Typ;
  kat: string;
  accName: string;
  kunde: string;
  accKey: string;
  ber: string;
  berKey: string;
  key: string;
  text: string;
  acc: string; // Account roh („Name|Kunde“), Schlüssel für Freigaben
  errorAccount: boolean;
  ohneAccount: boolean;
  intern: boolean;
  tage: [string, number][]; // nur Tage im Zeitraum
  stunden: number; // Summe im Zeitraum
}

export interface TagStatus {
  tag: string;
  status: 'vollstaendig' | 'teilweise' | 'fehlt' | 'abwesend' | 'feiertag' | 'frei' | 'frei_gebucht' | 'ausserhalb' | 'zukunft';
  soll: number;
  B: number;
  P: number;
  I: number;
  A: number;
  ist: number;
  offen: number;
  hinweis: string; // z. B. Feiertagsname, "Wochenende"
}

export interface PersonAuswertung {
  person: string;
  team: string;
  teams: string[]; // alle Teams (Teamwechsel)
  standort: string;
  standortAbgeleitet: string;
  sollTag: number;
  arbeitstage: number[];
  von: string;
  bis: string | null; // null = offen
  letzteBuchung: string | null;
  ausgeblendet: boolean;
  aktiv: boolean;
  // Summen im Zeitraum (bis Stichtag)
  soll: number;
  ist: number;
  offen: number;
  fehltage: number;
  sollTage: number;
  vollstaendig: boolean;
  B: number;
  P: number;
  I: number;
  A: number;
  billableQuote: number | null; // B / (B + P + I)
  utilization: number | null; // (B + P) / (B + P + I)
  tageStatus: TagStatus[]; // alle Tage des Zeitraums (auch nach Stichtag → 'zukunft')
  kontierung: [number, number, number, number]; // [Gruppen, #Niedrig, #Mittel, #Hoch] (K + P)
  texte: [number, number, number, number]; // T
  regelwerk: [number, number, number, number]; // R
  eintraegeZeitraum: number; // Einträge ohne A im Zeitraum
  texteUnauffaellig: number | null; // 0..1
  rueckfrage: string; // fertiger Rückfrage-Text (siehe docs/wca.md)
}

export interface Feiertag {
  standort: string;
  tag: string;
  name: string;
  quelle: 'berechnet' | 'manuell' | 'erkannt';
}

export interface Zeitraum {
  id: string; // 'YYYY-MM', 'YYYY-Www' oder 'alle'; bei mehreren Zeiträumen kommagetrennt
  text: string; // 'November 2026', 'KW 46 (09.11.–15.11.)', 'Alles bis Stichtag'
  von: string; // frühester Tag
  bis: string; // spätester Tag
  /** nur bei mehreren gewählten Zeiträumen: die (zusammengefassten) Teilbereiche; Tage dazwischen zählen nicht */
  teile?: { von: string; bis: string }[];
}

export interface Auswertung {
  stand: { minTag: string | null; maxTag: string | null; dateien: number; personen: number };
  stichtag: string;
  stichtagVorschlag: string;
  zeitraum: Zeitraum;
  zeitraeume: Zeitraum[]; // Auswahl für den Filter
  accountPflichtAb: string;
  personen: PersonAuswertung[];
  eintraege: AuswEintrag[]; // nur Einträge mit Tagen im Zeitraum
  gruppen: FundGruppe[]; // alle Fundgruppen (ohne Stufenfilter; Filter macht die Oberfläche)
  feiertage: Feiertag[]; // im Zeitraum
  regeln: RegelInfo[];
  freigegeben: number; // Funde im Zeitraum, die wegen einer Freigabe nicht gemeldet werden
}

export interface RegelInfo {
  id: string;
  kategorie: Kategorie;
  art: Art;
  name: string;
  erkennung: string;
  tipp: string;
  aktiv: boolean;
  anzahl: number; // Funde im Zeitraum
  stunden: number;
}
