import type { BelegVorschlag } from './typen';

/**
 * Auftrag aus Beleg: Übergabe eines gelesenen Belegs von der Auftragsliste bzw. dem Posteingang an die Neuanlage
 * (/transport/auftraege/neu/F). In der Adresse steht nichts davon: Der Aufrufer merkt den Beleg hier vor und gibt nur den
 * Schlüssel im Router-State mit; die Neuanlage holt ihn genau einmal ab. Nach „Neu laden“ oder „Zurück“ ist nichts mehr da –
 * dann öffnet sich die leere Maske. Ohne React, getestet in server/test/transport_beleguebernahme.test.ts.
 */
export interface BelegQuelle {
  vorschlag: BelegVorschlag;
  dateiName: string;
  /** hochgeladene Datei (Auftragsliste, Neuanlage) – wird nach dem Speichern an den Auftrag gehängt */
  datei: File | null;
  /** Anhang einer E-Mail im Posteingang: Vorgang (E-Mail) und Dokument; nach dem Speichern wird die E-Mail dem Auftrag zugeordnet */
  eingang: { vorgang: number; dokument: number; betreff: string | null } | null;
}

let zaehler = 0;
const vorgemerkt = new Map<number, BelegQuelle>();

/** Beleg vormerken; Rückgabe = Schlüssel für den Router-State. Es gibt immer nur einen vorgemerkten Beleg. */
export function belegMerken(q: BelegQuelle): number {
  vorgemerkt.clear();
  zaehler += 1;
  vorgemerkt.set(zaehler, q);
  return zaehler;
}

/** vorgemerkten Beleg abholen (danach ist er weg); schluessel = Wert aus dem Router-State, beliebiger Herkunft */
export function belegAbholen(schluessel: unknown): BelegQuelle | null {
  if (typeof schluessel !== 'number') return null;
  const q = vorgemerkt.get(schluessel) ?? null;
  vorgemerkt.delete(schluessel);
  return q;
}

/** Router-State: `beleg` für die Neuanlage; `hinweis` für den gespeicherten Auftrag, wenn der Beleg nicht angehängt werden konnte */
export interface BelegState { beleg?: number; hinweis?: string }
