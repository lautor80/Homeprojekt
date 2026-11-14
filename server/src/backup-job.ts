import crypto from 'node:crypto';
import { BusinessError } from './errors.js';

/**
 * Laufende Sicherungen mit Fortschritt und geschätzter Restdauer (Administration → System → Sicherung).
 *
 * Phasen und ihr Anteil am Fortschrittsbalken:
 *   lesen 0–85 % (nach gelesenen Zeilen im Verhältnis zur PostgreSQL-Schätzung),
 *   packen 85–95 %, speichern bzw. hochladen 95–100 %; bei dateiweiser Übertragung in die Nextcloud
 *   (ohne ZIP) Dateien übertragen 85–97 %, danach Prüfung der Übertragung und Aufräumen.
 * Die Restdauer ergibt sich aus der bisherigen Laufzeit und dem erreichten Anteil (ab 3 %).
 * Es läuft immer höchstens eine Sicherung gleichzeitig; fertige Aufträge bleiben 30 Minuten abrufbar.
 */

export type Phase = 'start' | 'lesen' | 'packen' | 'speichern' | 'hochladen' | 'dateien' | 'pruefen' | 'aufraeumen' | 'fertig' | 'fehler';
const PHASE_TEXT: Record<Phase, string> = {
  start: 'Wird vorbereitet …', lesen: 'Daten werden gelesen', packen: 'Datei wird gepackt', speichern: 'Datei wird gespeichert',
  hochladen: 'Upload in die Nextcloud', dateien: 'Dateien werden einzeln in die Nextcloud übertragen', pruefen: 'Übertragung wird geprüft', aufraeumen: 'Alte Sicherungen werden aufgeräumt', fertig: 'Fertig', fehler: 'Fehler',
};
const ANTEIL: Record<Phase, [number, number]> = {
  start: [0, 0], lesen: [0, 85], packen: [85, 95], speichern: [95, 100], hochladen: [95, 97], dateien: [85, 97], pruefen: [97, 99], aufraeumen: [99, 100], fertig: [100, 100], fehler: [0, 0],
};

export interface Job {
  id: string;
  art: 'sicherung' | 'nextcloud';
  von: string;
  start: number;
  phase: Phase;
  /** Teilfortschritt der Phase 0..1 */
  teil: number;
  detail: string;
  fehler: string | null;
  ergebnis: Record<string, unknown> | null;
  ende: number | null;
}

export interface JobSicht {
  id: string; art: Job['art']; von: string; phase: Phase; text: string; detail: string; prozent: number;
  laufzeitSekunden: number; restSekunden: number | null; fertig: boolean; fehler: string | null; ergebnis: Record<string, unknown> | null;
}

const jobs = new Map<string, Job>();

export function prozent(j: Job): number {
  if (j.phase === 'fertig') return 100;
  const [a, b] = ANTEIL[j.phase];
  return Math.max(0, Math.min(99, Math.floor(a + (b - a) * Math.max(0, Math.min(1, j.teil)))));
}

export function sicht(j: Job, jetzt = Date.now()): JobSicht {
  const p = prozent(j);
  const lauf = ((j.ende ?? jetzt) - j.start) / 1000;
  const laeuft = j.phase !== 'fertig' && j.phase !== 'fehler';
  return {
    id: j.id, art: j.art, von: j.von, phase: j.phase, text: PHASE_TEXT[j.phase], detail: j.detail, prozent: p,
    laufzeitSekunden: Math.round(lauf), restSekunden: laeuft && p >= 3 ? Math.max(1, Math.round((lauf * (100 - p)) / p)) : null,
    fertig: !laeuft, fehler: j.fehler, ergebnis: j.ergebnis,
  };
}

export function laufend(): Job | null {
  for (const j of jobs.values()) if (j.phase !== 'fertig' && j.phase !== 'fehler') return j;
  return null;
}

function aufraeumen() {
  const grenze = Date.now() - 30 * 60_000;
  for (const [id, j] of jobs) if (j.ende && j.ende < grenze) jobs.delete(id);
}

/** Auftrag im Hintergrund starten; `fn` meldet Fortschritt über `setze` */
export function starten(art: Job['art'], von: string,
  fn: (setze: (phase: Phase, teil?: number, detail?: string) => void) => Promise<Record<string, unknown>>): Job {
  aufraeumen();
  const l = laufend();
  if (l) throw new BusinessError(`Es läuft bereits eine Sicherung (${l.von}, ${PHASE_TEXT[l.phase]}) – bitte warten, bis sie fertig ist.`, 409);
  const j: Job = { id: crypto.randomUUID(), art, von, start: Date.now(), phase: 'start', teil: 0, detail: '', fehler: null, ergebnis: null, ende: null };
  jobs.set(j.id, j);
  const setze = (phase: Phase, teil = 0, detail?: string) => { j.phase = phase; j.teil = teil; if (detail !== undefined) j.detail = detail; };
  // im nächsten Tick starten, damit die Anfrage sofort mit der Auftragsnummer antworten kann
  setImmediate(() => {
    fn(setze)
      .then((r) => { j.ergebnis = r; j.phase = 'fertig'; j.teil = 1; })
      .catch((e) => { j.fehler = (e as Error).message || String(e); j.phase = 'fehler'; })
      .finally(() => { j.ende = Date.now(); });
  });
  return j;
}

export const lesen = (id: string) => jobs.get(id) ?? null;
