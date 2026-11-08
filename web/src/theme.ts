import { setTheme } from '@ui5/webcomponents-base/dist/config/Theme.js';

/**
 * Hell/Dunkel (SAP Horizon bzw. Horizon Dark). Die Wahl wird im Browser gemerkt;
 * ohne Wahl gilt die Systemeinstellung.
 */
const KEY = 'portal.theme';
export type Erscheinung = 'hell' | 'dunkel';

export function aktuelleErscheinung(): Erscheinung {
  const gespeichert = localStorage.getItem(KEY) as Erscheinung | null;
  if (gespeichert === 'hell' || gespeichert === 'dunkel') return gespeichert;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dunkel' : 'hell';
}

export function erscheinungSetzen(e: Erscheinung, merken = true): void {
  if (merken) localStorage.setItem(KEY, e);
  document.documentElement.dataset.portalTheme = e;
  void setTheme(e === 'dunkel' ? 'sap_horizon_dark' : 'sap_horizon');
}

/** beim Start aufrufen */
export function erscheinungInitialisieren(): void {
  erscheinungSetzen(aktuelleErscheinung(), false);
}
