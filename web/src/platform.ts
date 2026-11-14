import type { ComponentType } from 'react';

/**
 * Schnittstelle eines Fachmoduls (Oberfläche).
 * Registrierung in web/src/modules.ts.
 */
export interface NavEntry {
  text: string;
  /** UI5-Icon, z. B. "group", "shipping-status", "lead" */
  icon?: string;
  /** Pfad innerhalb der App, z. B. "/beispiel/kontakte" */
  path?: string;
  /** Eintrag nur sichtbar mit dieser Berechtigung */
  permission?: string;
  children?: NavEntry[];
  /** Stufe 1: Einträge darunter in der Seitenleiste einrücken */
  einruecken?: boolean;
}

export interface RouteDef {
  /** react-router-Pfad, z. B. "/beispiel/kontakte/:id" */
  path: string;
  component: ComponentType;
  permission?: string;
}

/** Kennzahl auf einer Kachel (wie der Zahlenwert einer FLP-Kachel) */
export interface TileKpi {
  /** Anzeigewert, z. B. "123" oder "1.250,00 €" */
  value: string;
  /** kurze Erläuterung unter dem Wert, z. B. "aktive Mitglieder" */
  label?: string;
  state?: 'None' | 'Positive' | 'Negative' | 'Critical' | 'Information';
}

/** Kachel auf der Startseite */
export interface HomeTile {
  text: string;
  subtitle?: string;
  icon: string;
  path: string;
  permission?: string;
  /**
   * Optionale Kennzahl: wird beim Anzeigen der Startseite geladen (nur, wenn der
   * Benutzer die Kachel sehen darf). Fehler werden still ignoriert – dann bleibt
   * die Kachel ohne Zahl.
   */
  kpi?: () => Promise<TileKpi>;
}

/** Kapitel der App „Einstellungen“ (#232, E1): Ein Modul meldet seine Einstellungen als Kapitel an, statt eine eigene App dafür zu führen */
export interface EinstellungsKapitel {
  /** eindeutig im Modul – steht als ?kapitel=<modul>.<id> in der Adresse */
  id: string;
  text: string;
  icon?: string;
  /** Recht, mit dem man das Kapitel sieht und pflegt (mehrere mit „|“ = eines davon genügt) */
  permission: string;
  component: ComponentType;
}

export interface WebModule {
  id: string;
  name: string;
  /** Icon der Gruppe auf der Startseite */
  icon?: string;
  nav: NavEntry[];
  routes: RouteDef[];
  tiles?: HomeTile[];
  /**
   * Optionaler Inhalt für die Startseite oberhalb der Kacheln (z. B. ein Dashboard mit Kennzahlen).
   * Wird nur gezeigt, wenn der Benutzer die Berechtigung hat.
   */
  home?: { component: ComponentType; permission?: string };
  /**
   * Optionale Bausteine unten in der linken Navigationsleiste (z. B. Ablagefeld für Dateien).
   * Auf jeder Seite sichtbar, nur mit der Berechtigung; collapsed = Navigation eingeklappt.
   */
  sideWidgets?: { component: ComponentType<{ collapsed: boolean }>; permission?: string }[];
  /** unsichtbare Begleiter, solange jemand angemeldet ist (z. B. Hinweise an Menüeinträgen über `setNavHinweis`) – nur mit der Berechtigung */
  waechter?: { component: ComponentType; permission?: string }[];
  /**
   * Öffentliche Seiten ohne Anmeldung (z. B. Mitgliedsantrag unter /beitritt). Werden über den Pfad aufgerufen,
   * auch wenn niemand angemeldet ist; nur für Module, die der Server als aktiv meldet.
   */
  oeffentlich?: { pfad: string; component: ComponentType<OeffentlichProps> }[];
  /**
   * Pfade, die nach der Anmeldung erhalten bleiben (sonst landet man immer auf der Startseite) – z. B. Links aus
   * QR-Codes an der Anlage (/tco/schaden?anlage=…). Vergleich mit dem Pfad ohne Query-String.
   */
  nachAnmeldung?: string[];
  /** Kapitel dieser Anwendung in der App „Einstellungen“ (Administration → Einstellungen, #232 E1), in der Reihenfolge der Anzeige */
  einstellungen?: EinstellungsKapitel[];
  /** Arbeitsvorrat der Startseite: Zusatz des Moduls am Eintrag (z. B. Knopf „Zahlungsdaten“), siehe components/Arbeitsvorrat.tsx */
  arbeitsvorratZusatz?: import('./components/Arbeitsvorrat').AufgabenZusatz;
}

export interface OeffentlichProps { orgName: string; logo?: string; onFertig: () => void }
