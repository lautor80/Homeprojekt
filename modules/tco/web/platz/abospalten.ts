/** Abo-Verwaltung (#11): Wochentag und Uhrzeit als getrennte, filter- und sortierbare Spalten */
export const WOCHENTAG = ['', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];
export const wochentagText = (n: number) => WOCHENTAG[n] ?? String(n);
export const uhrzeitText = (von: string, bis: string) => `${von.slice(0, 5)}–${bis.slice(0, 5)} Uhr`;
/** Sortierschlüssel der Uhrzeit: Beginn, dann Ende (HH:MM vergleicht sich als Text richtig) */
export const uhrzeitOrdnung = (von: string, bis: string) => `${von.slice(0, 5)}${bis.slice(0, 5)}`;
