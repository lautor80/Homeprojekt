/**
 * Turniere (Oberfläche): gemeinsame Typen und Pfade. Fachtypen und Ergebnisprüfung kommen aus dem Server-Ordner
 * (ohne Server-Abhängigkeiten), damit Oberfläche und Server gleich zählen.
 */
import { TCO } from '../util';
import type { Runde, Spiel, Teilnehmer, Turnier } from '../../server/turnier/typen';

export * from '../../server/turnier/typen';
export { einzelAuswerten, spassAuswerten, ergebnisText, bilanzen, ErgebnisFehler, type Bilanz } from '../../server/turnier/wertung';

/** Verwaltung: /api/m/tco/turniere… */
export const T = `${TCO}/turniere`;
/** öffentlich: /api/m/tco/turnier… */
export const TO = `${TCO}/turnier`;

/** GET /turniere/:id */
export interface TurnierDetail {
  turnier: Turnier;
  teilnehmer: Teilnehmer[];
  runden: Runde[];
  spiele: Spiel[];
  /** Portal-Adresse aus den Einstellungen (für öffentliche Links/QR-Codes), null = nicht eingetragen */
  url: string | null;
}

/** GET /turnier/oeffentlich/:kennung/live bzw. /turniere/:id/live – daten ist modusspezifisch */
export interface LiveDaten<D = unknown> {
  turnier: Pick<Turnier, 'kennung' | 'name' | 'modus' | 'status' | 'beschreibung' | 'meldeschluss' | 'max_teilnehmer' | 'einstellungen'> & { modus_text: string };
  teilnehmer: { id: number; name: string; lk: number | null; status: Teilnehmer['status'] }[];
  daten: D;
  stand: string;
}

/** Props der modusspezifischen Verwaltung (Reiter in der Turnier-Detailseite) */
export interface VerwaltungProps { detail: TurnierDetail; darfPflegen: boolean; reload: () => void }
/** Props der modusspezifischen Live-Ansicht (öffentlich, Verwaltung und Beamer) */
export interface LiveProps<D = unknown> { live: LiveDaten<D>; gross?: boolean }

/** LK-Anzeige „LK 12,4“ */
export const lkText = (v: number | null | undefined) => (v == null ? '–' : `LK ${Number(v).toFixed(1).replace('.', ',')}`);
