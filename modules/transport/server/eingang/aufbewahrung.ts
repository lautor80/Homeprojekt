/**
 * Euroflex Posteingang – Aufbewahrung der Inhalte zugeordneter E-Mails (reine Logik, ohne Datenbank).
 *
 * Zugeordnete Dateien (übernommen in den Ablageordner, in Paperless abgelegt, Dublette) bleiben mit „aufbewahrenDauerhaft“
 * (Standard) im Portal und sind im Posteingang und am Auftrag jederzeit wieder herunterladbar. Ohne den Schalter werden sie
 * nach „aufbewahrenTage“ gelöscht (0 = sofort). Fehlt ein Inhalt (vor dieser Änderung gelöscht), füllt eine erneut gelieferte
 * E-Mail ihn wieder auf (nachladenZuordnen).
 */

/** Status, in denen ein Dokument einem Auftrag zugeordnet und erledigt ist – deren Inhalt fällt unter die Aufbewahrung */
export const ZUGEORDNET_ERLEDIGT = ['uebernommen', 'abgelegt', 'dublette'] as const;

export interface Aufbewahrung { aufbewahrenDauerhaft: boolean; aufbewahrenTage: number }

/** Inhalt beim Erledigen (Übernahme, Paperless, Dublette) im Portal lassen? */
export const inhaltBehalten = (e: Aufbewahrung): boolean => e.aufbewahrenDauerhaft || e.aufbewahrenTage > 0;

/** Tage, nach denen erledigte Inhalte gelöscht werden; null = nie */
export const loeschenNachTagen = (e: Aufbewahrung): number | null => (e.aufbewahrenDauerhaft ? null : e.aufbewahrenTage);

export function aufbewahrungText(e: Aufbewahrung): string {
  if (e.aufbewahrenDauerhaft) return 'Zugeordnete Dateien bleiben dauerhaft im Portal und können jederzeit wieder heruntergeladen werden.';
  if (e.aufbewahrenTage <= 0) return 'Zugeordnete Dateien werden nach der Ablage sofort aus dem Portal gelöscht.';
  return `Zugeordnete Dateien bleiben ${e.aufbewahrenTage} Tage im Portal und werden danach gelöscht.`;
}

export interface FehlendesDokument { id: number; art: 'anhang' | 'mail'; datei: string; sha256: string | null }
export interface GelieferteDatei { name: string; sha256: string }

/**
 * Welche gelieferte Datei füllt welches Dokument ohne Inhalt? Zuerst über die Prüfsumme (exakt dieselbe Datei), sonst über den
 * Dateinamen – jede gelieferte Datei höchstens einmal. Die E-Mail als PDF wird neu erzeugt (art 'mail'), nicht hier zugeordnet.
 */
export function nachladenZuordnen(fehlend: FehlendesDokument[], geliefert: GelieferteDatei[]): { id: number; index: number }[] {
  const frei = new Set(geliefert.map((_, i) => i));
  const erg: { id: number; index: number }[] = [];
  const anhaenge = fehlend.filter((d) => d.art === 'anhang');
  const offen: FehlendesDokument[] = [];
  for (const d of anhaenge) {
    const i = d.sha256 ? [...frei].find((x) => geliefert[x].sha256 === d.sha256) : undefined;
    if (i === undefined) { offen.push(d); continue; }
    frei.delete(i);
    erg.push({ id: d.id, index: i });
  }
  for (const d of offen) {
    const name = d.datei.toLowerCase();
    const i = [...frei].find((x) => geliefert[x].name.toLowerCase() === name);
    if (i === undefined) continue;
    frei.delete(i);
    erg.push({ id: d.id, index: i });
  }
  return erg;
}
