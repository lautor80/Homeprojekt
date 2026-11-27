/**
 * Platzverwaltung → Abos → „Termine“: einzelne Termine einer Abo-Serie stornieren – reine Funktionen ohne React.
 * Oberfläche: AboTermine.tsx, Server: aboTermineLesen / aboTerminVerwaltungStornieren (modules/tco/server/platz/logik.ts).
 * Test: server/test/tco_abo_termine.test.ts
 */

export interface AboTermin {
  datum: string; wochentag: string; von: string; bis: string; storniert: boolean; storno_grund: string | null; vergangen: boolean;
  abgerechnet: boolean; rechnung: string | null;
}

/** Anzeige: kommende Termine (ab heute), auf Wunsch auch die vergangenen; ein vorgewählter Termin bleibt immer sichtbar */
export function termineZeigen(termine: AboTermin[], auchVergangene: boolean, gewaehlt?: string | null): AboTermin[] {
  return termine.filter((t) => auchVergangene || !t.vergangen || t.datum === gewaehlt);
}

/** Stornieren ist möglich, solange der Termin nicht storniert ist – auch nachträglich */
export const stornierbar = (t: AboTermin) => !t.storniert;

/** abgerechnete Termine brauchen einen Kommentar (er steht danach an der Buchung) */
export const kommentarNoetig = (t: AboTermin) => t.abgerechnet;
export const stornoBereit = (t: AboTermin, kommentar: string) => stornierbar(t) && (!kommentarNoetig(t) || !!kommentar.trim());

/** Status-Text der Zeile */
export function terminStatus(t: AboTermin): { text: string; art: 'Negative' | 'Positive' | 'Critical' | 'None' } {
  if (t.storniert) return { text: t.storno_grund ? `storniert – ${t.storno_grund}` : 'storniert', art: 'Negative' };
  if (t.abgerechnet) return { text: t.rechnung ? `abgerechnet (Rechnung ${t.rechnung})` : 'abgerechnet', art: 'Positive' };
  return { text: t.vergangen ? 'gespielt, offen' : 'offen', art: t.vergangen ? 'Critical' : 'None' };
}

/** Überschrift: „3 kommende Termine, 1 storniert“ */
export function termineTitel(termine: AboTermin[]): string {
  const kommend = termine.filter((t) => !t.vergangen && !t.storniert).length;
  const storniert = termine.filter((t) => t.storniert).length;
  return `${kommend} kommende${kommend === 1 ? 'r Termin' : ' Termine'}${storniert ? `, ${storniert} storniert` : ''}`;
}
