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
}

export interface RouteDef {
  /** react-router-Pfad, z. B. "/beispiel/kontakte/:id" */
  path: string;
  component: ComponentType;
  permission?: string;
}

/** Kachel auf der Startseite */
export interface HomeTile {
  text: string;
  subtitle?: string;
  icon: string;
  path: string;
  permission?: string;
}

export interface WebModule {
  id: string;
  name: string;
  nav: NavEntry[];
  routes: RouteDef[];
  tiles?: HomeTile[];
}
