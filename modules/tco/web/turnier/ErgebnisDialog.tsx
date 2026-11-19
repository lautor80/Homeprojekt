import type { ErgebnisEingabeWeb, Spiel } from './api';

/**
 * Ergebnis eintragen (Verwaltung, „Mein Turnier“, Platz-QR) – Platzhalter, wird ausgebaut.
 * art 'einzel': bis zu 3 Sätze (dritter = Match-Tiebreak), Wertung gespielt/Aufgabe/kampflos (Liga zusätzlich „nicht gespielt“);
 * art 'spass': Spiele je Team. Prüft vor dem Senden mit einzelAuswerten/spassAuswerten und zeigt Fehler direkt an.
 */
export interface ErgebnisDialogProps {
  offen: boolean;
  spiel: Spiel;
  /** Anzeigenamen je Seite (Doppel: zwei Namen) */
  namenA: string[];
  namenB: string[];
  art: 'einzel' | 'spass';
  /** Liga: Wertung „nicht gespielt“ anbieten */
  liga?: boolean;
  /** wirft bei Fehler (Meldung wird im Dialog angezeigt) */
  onSpeichern: (e: ErgebnisEingabeWeb) => Promise<void>;
  onSchliessen: () => void;
}
export function ErgebnisDialog(_: ErgebnisDialogProps) { return null; }
