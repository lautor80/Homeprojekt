import { setNavHinweis } from './navhinweis';

/**
 * Arbeitsvorrat (#232, V2): was der Benutzer schon gesehen hat – für den Hinweis „n neu“ am Menüeintrag „Start“.
 * Gemerkt je Browser. Eigene Datei ohne Abhängigkeit zu den Modulen, damit auch deren Seiten sie einbinden können.
 */
interface Knoten { key: string; kinder?: Knoten[] }

export const START = '/';
const SPEICHER = 'portal.arbeitsvorrat.gesehen';
export const EREIGNIS = 'portal-arbeitsvorrat-gesehen';
export const schluessel = (l: Knoten[]): string[] => l.flatMap((a) => [a.key, ...schluessel(a.kinder ?? [])]);
function gesehenLesen(): string[] | null {
  try { const x = JSON.parse(localStorage.getItem(SPEICHER) ?? 'null'); return Array.isArray(x) ? x : null; } catch { return null; }
}
/** ohne Browserspeicher (privater Modus): gesehen gilt bis zum Neuladen */
let gesehenOhneSpeicher: string[] | null = null;
export const gesehen = (): string[] | null => gesehenLesen() ?? gesehenOhneSpeicher;
export function gesehenMerken(keys: string[]) {
  gesehenOhneSpeicher = keys;
  try { localStorage.setItem(SPEICHER, JSON.stringify(keys)); } catch { /* s. o. */ }
}

/**
 * Was angezeigt wird, gilt als gesehen – der Hinweis „n neu“ am Menüeintrag „Start“ verschwindet.
 * alles = true: die Liste ist der ganze Arbeitsvorrat (Startseite). Sonst ein Ausschnitt (z. B. Vereinsübersicht): kommt hinzu.
 */
export function aufgabenGesehen(liste: Knoten[], alles = false) {
  const keys = schluessel(liste);
  gesehenMerken(alles ? keys : [...new Set([...(gesehen() ?? []), ...keys])]);
  if (alles) setNavHinweis(START, 0); // alles gesehen – nichts neu zu zählen
  else window.dispatchEvent(new Event(EREIGNIS)); // Ausschnitt gesehen – der Wächter zählt den Rest neu
}
