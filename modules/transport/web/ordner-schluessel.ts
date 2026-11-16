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
