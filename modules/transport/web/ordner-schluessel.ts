/**
 * Ablageordner je Benutzer (reine Funktionen, ohne Browser): Der Verweis auf den Ordner liegt im Browser dieses PCs unter
 * einem Schlüssel je Benutzer. So legt jeder Benutzer seinen eigenen Ordner fest – auch wenn sich mehrere einen PC und ein
 * Windows-Konto teilen.
 */

/** bisheriger gemeinsamer Schlüssel (ein Ordner je PC und Browser) */
export const ORDNER_ALT = 'ordner';
/** Schlüssel des Benutzers; ohne Anmeldung der gemeinsame */
export const ordnerSchluessel = (benutzerId: string | null | undefined) => (benutzerId ? `ordner:${benutzerId}` : ORDNER_ALT);

/**
 * Welcher Ordner gilt: der eigene des Benutzers; hat er noch nichts festgelegt (undefined), der bisher gemeinsame des PCs –
 * damit bestehende Einrichtungen weiterlaufen. `false` = der Benutzer hat ausdrücklich „nicht mehr verwenden“ gewählt.
 */
export function ordnerWahl<T>(eigen: T | false | undefined, gemeinsam: T | undefined): { ordner: T | null; quelle: 'EIGEN' | 'GEMEINSAM' | 'KEINER' } {
  if (eigen === false) return { ordner: null, quelle: 'KEINER' };
  if (eigen !== undefined && eigen !== null) return { ordner: eigen, quelle: 'EIGEN' };
  return gemeinsam ? { ordner: gemeinsam, quelle: 'GEMEINSAM' } : { ordner: null, quelle: 'KEINER' };
}

// ---------------------------------------------------------------- Pfad im Ablageordner: <Ordner>/<Jahr>/<Auftragsnummer>/<Datei>

/** Zeichen, die in Datei- und Ordnernamen unter Windows nicht erlaubt sind, ersetzen */
export const sauber = (s: string) => s.replace(/[\\/:*?"<>|]/g, '_').trim();
/** Name, unter dem eine Posteingangsdatei im Unterordner Eingang/ liegt: der gemeldete, sonst der bereinigte Dateiname */
export const eingangName = (d: { datei: string; ablage_name?: string | null }) => (d.ablage_name?.trim() || sauber(d.datei) || 'Datei');
/** Jahresordner aus der Auftragsnummer („2026_1235“ → 2026); Nummern ohne Jahr kommen nach „Sonstige“ */
export const jahrVon = (nr: string) => (/^\d{4}/.test(nr) ? nr.slice(0, 4) : 'Sonstige');
/** Ordner eines Auftrags unter dem Ablageordner: [Jahr, Auftragsnummer] */
export const auftragsPfad = (nr: string): [string, string] => [jahrVon(nr), sauber(nr)];
/** Anzeigepfad, z. B. „Aufträge/2026/2026_1314/Rechnung_2026_6200.pdf“ */
export function anzeigePfad(basis: string, nr: string, datei?: string) {
  return [basis, ...auftragsPfad(nr), datei ? sauber(datei) : ''].filter(Boolean).join('/');
}
