/**
 * Unzustellbare Empfängeradressen: Verbindung zwischen dem zentralen Versand (lib/mail.ts), dem Maileingang
 * (lib/maileingang-db.ts) und den Fachmodulen. Der Kern kennt keine Personen – die Module vermerken unzustellbare Adressen bei
 * ihren Personen (ServerModule.mailUnzustellbar, z. B. im Mitgliederstamm) und nennen die gesperrten (ServerModule.mailGesperrt).
 *
 * Fehler eines Moduls halten weder den Versand noch den Maileingang auf: Eine Sperre, die sich nicht prüfen lässt, gilt als
 * nicht gesetzt (lieber eine E-Mail zu viel versucht als alle Mails blockiert).
 */
import type { ServerModule } from '../module.js';

// nachgeladen: modules.ts lädt die Fachmodule, und die laden lib/mail.ts
const module = async (): Promise<ServerModule[]> => (await import('../modules.js')).activeModules();

/** gesperrte Adressen (klein geschrieben) mit Grund */
export async function gesperrteAdressen(emails: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const liste = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
  if (!liste.length) return out;
  for (const m of await module()) {
    if (!m.mailGesperrt) continue;
    try {
      for (const g of await m.mailGesperrt(liste)) if (!out.has(g.email.toLowerCase())) out.set(g.email.toLowerCase(), g.grund);
    } catch { /* siehe oben */ }
  }
  return out;
}

/** dauerhaft abgelehnte Adressen an die Module melden; zurück kommen die Adressen, zu denen ein Vermerk gesetzt wurde */
export async function unzustellbarMelden(emails: string[], grund: string, quelle: 'versand' | 'ruecklaeufer'): Promise<string[]> {
  const liste = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
  const vermerkt: string[] = [];
  if (!liste.length) return vermerkt;
  for (const m of await module()) {
    if (!m.mailUnzustellbar) continue;
    try {
      for (const a of await m.mailUnzustellbar({ emails: liste, grund, quelle })) if (!vermerkt.includes(a)) vermerkt.push(a);
    } catch { /* siehe oben */ }
  }
  return vermerkt;
}

/** Text für Ergebnis und E-Mail-Protokoll einer unterdrückten E-Mail */
export const SPERRTEXT = 'als unzustellbar vermerkt';
