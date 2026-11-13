/** FI-Belege „Überweisung an Einreicher“: reine Regeln zu den Paperless-Feldern (ohne Zugriff auf Paperless) */

export type Option = string | { id: string; label: string };

/** Text der Folgeaktion: bei Auswahlfeldern steht im Dokument die Kennung der Option, sonst der Text selbst */
export function folgeText(wert: unknown, optionen: Option[] = []): string {
  if (wert === null || wert === undefined) return '';
  const w = String(wert);
  const o = optionen.find((x) => typeof x !== 'string' && x.id === w);
  if (o && typeof o !== 'string') return o.label;
  // ältere Paperless-Versionen: Index der Option
  if (/^\d+$/.test(w) && optionen.length && typeof optionen[0] === 'string' && optionen[Number(w)] !== undefined) return optionen[Number(w)] as string;
  return w;
}
/** Feld „SAP“ leer: nicht gesetzt, leer oder (Ja/Nein-Feld) nicht angehakt */
export const sapLeer = (v: unknown): boolean => v === null || v === undefined || v === false || String(v).trim() === '' || String(v).toLowerCase() === 'false';

/** Wert, der für eine Auswahl-Option ins Dokument geschrieben wird (Kennung der Option, bei alten Feldern ihr Index); null, wenn es sie nicht gibt */
export function optionWert(optionen: Option[], label: string): string | number | null {
  const i = optionen.findIndex((o) => (typeof o === 'string' ? o : o.label).trim().toLowerCase() === label.trim().toLowerCase());
  if (i < 0) return null;
  const o = optionen[i];
  return typeof o === 'string' ? i : o.id;
}
/** Status „Offen“ (Groß-/Kleinschreibung egal) */
export const statusOffen = (text: string): boolean => text.trim().toLowerCase() === 'offen';
