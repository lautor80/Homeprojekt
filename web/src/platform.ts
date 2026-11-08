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
}
