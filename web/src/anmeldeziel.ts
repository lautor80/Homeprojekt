/**
 * Ziel nach der Registrierung: Wer über einen Link kommt, den ein Modul nach der Anmeldung erhält (WebModule.nachAnmeldung,
 * z. B. der Einladungslink einer Veranstaltung), aber noch keinen Zugang hat, registriert sich erst – bis der Zugang
 * besteht, vergehen Minuten bis Tage, und die erste Anmeldung beginnt dann auf der Startseite. Damit die Einladung nicht
 * verloren geht, merkt sich der Browser das Ziel beim Klick auf „Registrieren“ und führt nach der ersten Anmeldung
 * einmal dorthin.
 *
 * Gemerkt wird nur eine Adresse im Portal, deren Pfad ein Modul ausdrücklich freigibt – nie eine fremde Adresse.
 */
const SCHLUESSEL = 'portal.anmeldeziel';
export const ZIEL_TAGE = 30;

export interface Ziel { pfad: string; zeit: number }

/** gemerktes Ziel prüfen: nur Pfade im Portal, die ein Modul nach der Anmeldung erhält, und nur ZIEL_TAGE lang */
export function zielPruefen(roh: string | null, erlaubt: string[], jetzt = Date.now()): string | null {
  if (!roh) return null;
  let z: Partial<Ziel>;
  try { z = JSON.parse(roh) as Partial<Ziel>; } catch { return null; }
  if (!z || typeof z.pfad !== 'string' || typeof z.zeit !== 'number') return null;
  if (jetzt - z.zeit > ZIEL_TAGE * 86_400_000 || z.zeit > jetzt + 60_000) return null;
  // nur eine Adresse im Portal: genau ein führender Schrägstrich, kein Schema, kein Rückstrich
  if (!/^\/[^/\\]/.test(z.pfad) || z.pfad.includes('://') || z.pfad.includes('\\')) return null;
  const pfad = z.pfad.split(/[?#]/)[0].replace(/\/+$/, '');
  return erlaubt.includes(pfad) ? z.pfad : null;
}

export function zielMerken(pfadMitZusatz: string): void {
  try { window.localStorage.setItem(SCHLUESSEL, JSON.stringify({ pfad: pfadMitZusatz, zeit: Date.now() } satisfies Ziel)); } catch { /* ohne Speicher: kein Ziel */ }
}

export function zielVergessen(): void {
  try { window.localStorage.removeItem(SCHLUESSEL); } catch { /* nichts gemerkt */ }
}

/** gemerktes Ziel einmal abholen (danach ist es vergessen) */
export function zielAbholen(erlaubt: string[]): string | null {
  try {
    const roh = window.localStorage.getItem(SCHLUESSEL);
    if (roh === null) return null;
    window.localStorage.removeItem(SCHLUESSEL);
    return zielPruefen(roh, erlaubt);
  } catch { return null; }
}
