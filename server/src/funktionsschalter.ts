/**
 * Funktionsschalter (#232, F1): Zustand im Speicher und die Abfragen, die überall gebraucht werden.
 *
 * Bewusst ohne Importe – die zentrale Rechteprüfung (permissions.ts) und die Module fragen hier ab, ohne dass ein
 * Kreis von Importen entsteht. Berechnet und geladen wird der Zustand in lib/funktionen.ts.
 *
 * Der Schalter entscheidet, OB es eine Funktion in dieser Installation gibt; das Recht, WER sie nutzt. Abgeschaltet
 * heißt für alle aus, auch für Administratoren: Rechte gelten als nicht vorhanden, Routen antworten mit 403.
 */

/** Eine einzelne Funktion innerhalb einer App, die ein Modul zum Abschalten anmeldet (ServerModule.funktionen) */
export interface FunktionDef {
  /** stabile Id mit Modulpräfix, z. B. „tco.halle.ep3import“ – wird gespeichert, also nie umbenennen */
  id: string;
  /** App, zu der die Funktion gehört – Name wie im Rechtekatalog (und im Menü) */
  app: string;
  /** kurzer Name in der Pflege, z. B. „EP3-Import“ */
  text: string;
  /** ein Satz: was es ohne die Funktion nicht mehr gibt */
  beschreibung: string;
  /** Rechte, die es ohne die Funktion nicht gibt – wirkt überall, wo das Recht geprüft wird (Server und Oberfläche) */
  permissions?: string[];
  /**
   * Routen, die ohne die Funktion abgewiesen werden: „METHODE /pfad“ wie im Modul deklariert (ohne /api/m/<modul>),
   * z. B. „POST /halle/import/n8n“. Im Kern mit vollem Pfad („POST /api/…“).
   */
  routen?: string[];
  /** Hinweis in der Pflege, was sonst noch davon abhängt */
  hinweis?: string;
}

export interface SchalterZustand {
  /** Ids aller abgeschalteten Knoten – einschließlich allem, was unter einem abgeschalteten Knoten liegt */
  ids: Set<string>;
  /** Rechte, die es dadurch nicht gibt – einschließlich der Rechte, die eines davon voraussetzen */
  rechte: Set<string>;
  /** abgewiesene Routen „METHODE /api/…“ → Name der abgeschalteten Funktion */
  routen: Map<string, string>;
}

let zustand: SchalterZustand = { ids: new Set(), rechte: new Set(), routen: new Map() };

export const schalterZustand = (): SchalterZustand => zustand;
export const schalterSetzen = (z: SchalterZustand): void => { zustand = z; };

/** Gibt es dieses Recht in dieser Installation gerade nicht? */
export const rechtAbgeschaltet = (recht: string): boolean => zustand.rechte.has(recht);
/** Ist die Funktion (Id aus ServerModule.funktionen) an? */
export const funktionAktiv = (id: string): boolean => !zustand.ids.has(id);
/** Ist die App an – für automatische Läufe, die ohne Benutzer und damit ohne Rechteprüfung arbeiten */
export const appAktiv = (modul: string, app: string): boolean => !zustand.ids.has(appId(modul, app));
/** Name der abgeschalteten Funktion, zu der die Route gehört – sonst null */
export const routeAbgeschaltet = (methode: string, muster: string): string | null => zustand.routen.get(`${methode} ${muster}`) ?? null;

export const modulId = (modul: string) => `m:${modul}`;
export const bereichId = (modul: string, bereich: string) => `b:${modul}:${bereich}`;
export const appId = (modul: string, app: string) => `a:${modul}:${app}`;

export const FUNKTION_AUS = 'FUNKTION_AUS';
export const funktionAusText = (name?: string | null) =>
  `${name ? `Die Funktion „${name}“` : 'Diese Funktion'} ist abgeschaltet (Administration → Einstellungen → Funktionen).`;
