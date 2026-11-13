/**
 * Strg+V und die Ablage: Tabellenprogramme (Excel, LibreOffice) legen beim Kopieren von Zellen neben dem Text auch ein
 * **Bild der Zellen** in die Zwischenablage. Wer so etwas in ein Eingabefeld einfügt, will den Text – nicht das Bild
 * als Dokument ablegen (#215: Altdaten einfügen öffnete die Paperless-Ablage).
 */
const FELD = /^(INPUT|TEXTAREA|UI5-INPUT|UI5-TEXTAREA|UI5-COMBOBOX|UI5-MULTI-INPUT)$/;

/** steht der Cursor in einem Eingabefeld? (Pfad des Ereignisses, auch durch Shadow DOM) */
export function imEingabefeld(pfad: { tagName?: string; isContentEditable?: boolean }[]): boolean {
  return pfad.some((x) => (x.tagName && FELD.test(x.tagName)) || x.isContentEditable === true);
}

/** Dateien aus der Zwischenablage ablegen? Nicht, wenn Text in ein Eingabefeld eingefügt wird. */
export function einfuegenAblegen(dateien: number, text: string, imFeld: boolean): boolean {
  if (!dateien) return false;
  return !(imFeld && text.trim().length > 0);
}
