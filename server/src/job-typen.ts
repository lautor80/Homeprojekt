/**
 * Jobs (Administration → System → Jobs): Verträge zwischen Kern, Modulen und Oberfläche – reine Typen ohne Importe.
 *
 * Ein Job ist eine Funktion, die als einzelner **Lauf** ausgeführt wird: eingeplant nach Plan (Intervall oder täglich zu
 * einer Uhrzeit, wahlweise nur an bestimmten Wochentagen) oder von Hand („Jetzt ausführen“). Jeder Lauf hat ein eigenes
 * Protokoll (Zeilen mit Zeit, Stufe und Text), das in der App einsehbar ist.
 *
 * Kern-Jobs stehen in server/src/jobs-kern.ts, Module melden ihre Jobs über ServerModule.jobs an (Ids mit Präfix „<modul>.“).
 */

/** Zeitplan eines Jobs. Zeiten gelten in Europe/Berlin. */
export type JobPlan =
  | { art: 'intervall'; minuten: number }
  /** wochentage: 1 = Montag … 7 = Sonntag; leer = jeden Tag */
  | { art: 'taeglich'; uhrzeit: string; wochentage: number[] };

export type JobStufe = 'info' | 'warnung' | 'fehler';
export type LaufStatus = 'LAEUFT' | 'OK' | 'WARNUNG' | 'FEHLER' | 'ABGEBROCHEN' | 'LEER';
export type LaufAusloeser = 'PLAN' | 'MANUELL';

export interface JobKontext {
  /** Nummer des Laufs (core.job_laeufe.id) */
  laufId: number;
  /** true = von Hand gestartet („Jetzt ausführen“); false = nach Plan */
  manuell: boolean;
  /** Benutzer bzw. „system (Jobplanung)“ – für Änderungsbelege (withChange username) */
  von: { id: string | null; name: string };
  /** Zeile ins Protokoll des Laufs schreiben (Vorgabe Stufe „info“) */
  log: (text: string, stufe?: JobStufe) => void;
  /** Abbruch angefordert (Administration → „Abbrechen“) – lange Läufe prüfen das zwischendurch */
  signal: AbortSignal;
  /**
   * Nach Plan gab es nichts zu tun (z. B. Fälligkeit laut Fach-Einstellung noch nicht erreicht): Der Lauf wird nicht
   * aufbewahrt (Status LEER), damit minütliche Prüfungen das Protokoll nicht fluten. Bei manuellen Läufen wirkungslos.
   */
  leer: () => void;
}

export interface JobDef {
  /** "<modul>.<name>", z. B. "tco.platz.abolauf"; Kern: "core.<name>" */
  id: string;
  /** Anzeigename, z. B. „Abo-Bewerbungen: Erinnerung, Verfall, Angebote“ */
  text: string;
  /** ein bis zwei Sätze: was der Lauf tut, auch was er bei „Jetzt ausführen“ anders macht */
  beschreibung: string;
  /** Gruppierung in der App (Menübereich/App der Fachanwendung), z. B. „Sport → Platz buchen“ */
  bereich: string;
  /** Plan, solange niemand ihn geändert hat */
  standardPlan: JobPlan;
  /** ohne Änderung in der Administration eingeplant? (Vorgabe true) */
  standardEingeplant?: boolean;
  /** zusätzliche Berechtigung für „Jetzt ausführen“ (neben core.jobs:execute), z. B. "tco.mahnung:execute" */
  recht?: string;
  /**
   * Die Arbeit des Laufs. Rückgabe: kurze Zusammenfassung (Ergebnisspalte). Eine geworfene Ausnahme beendet den Lauf mit
   * Status FEHLER (Meldung steht im Protokoll); Zeilen der Stufe „warnung“ machen aus OK den Status WARNUNG.
   */
  ausfuehren: (ctx: JobKontext) => Promise<string | void>;
}
