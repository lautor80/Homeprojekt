import { useEffect } from 'react';
import { api } from '@core/api';
import { setNavHinweis } from '@core/navhinweis';
import { DASH } from './typen';

/**
 * Neue Aufgaben im Arbeitsvorrat am Menüeintrag „Vereinsübersicht“ anzeigen.
 * „Neu“ ist, was seit dem letzten Besuch der Vereinsübersicht hinzugekommen ist – gemerkt je Browser (gesehene Schlüssel).
 * Unsichtbar; prüft beim Start, alle zwei Minuten und wenn das Fenster wieder nach vorn kommt.
 */
const PFAD = '/tco/uebersicht';
const SPEICHER = 'tco.arbeitsvorrat.gesehen';
const EREIGNIS = 'tco-arbeitsvorrat-gesehen';
interface Knoten { key: string; kinder?: Knoten[] }

const schluessel = (l: Knoten[]): string[] => l.flatMap((a) => [a.key, ...schluessel(a.kinder ?? [])]);
function gesehenLesen(): string[] | null {
  try { const x = JSON.parse(localStorage.getItem(SPEICHER) ?? 'null'); return Array.isArray(x) ? x : null; } catch { return null; }
}

/** von der Vereinsübersicht aufgerufen: alles, was gerade angezeigt wird, gilt als gesehen */
export function aufgabenGesehen(liste: Knoten[]) {
  try { localStorage.setItem(SPEICHER, JSON.stringify(schluessel(liste))); } catch { /* ohne Speicher: Hinweis bleibt bis zum Neuladen aus */ }
  setNavHinweis(PFAD, 0);
  window.dispatchEvent(new Event(EREIGNIS));
}

export function AufgabenWaechter() {
  useEffect(() => {
    let gesehenOhneSpeicher: string[] | null = null;
    const pruefen = async () => {
      try {
        const keys = schluessel(await api.get<Knoten[]>(`${DASH}/arbeitsvorrat`));
        let gesehen = gesehenLesen() ?? gesehenOhneSpeicher;
        // erster Aufruf in diesem Browser: der heutige Stand gilt als bekannt
        if (!gesehen) { gesehen = keys; gesehenOhneSpeicher = keys; try { localStorage.setItem(SPEICHER, JSON.stringify(keys)); } catch { /* s. o. */ } }
        const bekannt = new Set(gesehen);
        setNavHinweis(PFAD, keys.filter((k) => !bekannt.has(k)).length);
      } catch { /* keine Berechtigung oder offline – kein Hinweis */ }
    };
    pruefen();
    const t = setInterval(pruefen, 120_000);
    const sichtbar = () => { if (document.visibilityState === 'visible') pruefen(); };
    const merken = () => { gesehenOhneSpeicher = gesehenLesen() ?? gesehenOhneSpeicher; };
    document.addEventListener('visibilitychange', sichtbar);
    window.addEventListener(EREIGNIS, merken);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', sichtbar); window.removeEventListener(EREIGNIS, merken); };
  }, []);
  return null;
}
