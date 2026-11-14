/**
 * E-Mail-Protokoll als App (Administration → Protokolle → E-Mail-Protokoll): reine Hilfsfunktionen ohne Datenbank.
 * Empfängeradressen eines Protokolleintrags, Zuordnung Adresse → Person (Mitglied, Kunde, Benutzer …) und Freitextsuche.
 */

/** Wem eine Adresse gehört – der Kern meldet Benutzer, Module ihre Personen (ServerModule.mailPersonen) */
export interface MailPerson { email: string; name: string; art: string }

/** Einzelne Adressen aus dem Feld „an“ (mehrere mit Komma/Semikolon, auch „Name <adresse>“), klein geschrieben */
export function adressen(an: string | null | undefined): string[] {
  const teile = (an ?? '').replace(/[<>"']/g, ' ').split(/[,;\s]+/).map((x) => x.trim().toLowerCase()).filter((x) => /^[^\s@]+@[^\s@]+$/.test(x));
  return [...new Set(teile)];
}

/** Adresse → „Name (Art, Art)“; mehrere Personen mit derselben Adresse (Familie) werden alle genannt */
export function personenIndex(personen: MailPerson[]): Map<string, string> {
  const jeAdresse = new Map<string, Map<string, { name: string; arten: string[] }>>();
  for (const p of personen) {
    const email = (p.email ?? '').trim().toLowerCase();
    const name = (p.name ?? '').replace(/\s+/g, ' ').trim();
    if (!email || !name) continue;
    const namen = jeAdresse.get(email) ?? new Map<string, { name: string; arten: string[] }>();
    const e = namen.get(name.toLowerCase()) ?? { name, arten: [] };
    if (p.art && !e.arten.includes(p.art)) e.arten.push(p.art);
    namen.set(name.toLowerCase(), e);
    jeAdresse.set(email, namen);
  }
  const index = new Map<string, string>();
  for (const [email, namen] of jeAdresse) {
    index.set(email, [...namen.values()].map((e) => (e.arten.length ? `${e.name} (${e.arten.join(', ')})` : e.name)).join(' · '));
  }
  return index;
}

/** Personen zu den Empfängern eines Eintrags ('' = keine bekannt) */
export function personenText(an: string | null | undefined, index: Map<string, string>): string {
  return [...new Set(adressen(an).map((a) => index.get(a)).filter((x): x is string => !!x))].join(' · ');
}

/** Freitextsuche: jedes Wort muss in einem der Felder vorkommen (Groß-/Kleinschreibung egal) */
export function passt(suche: string | null | undefined, felder: (string | null | undefined)[]): boolean {
  const worte = (suche ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!worte.length) return true;
  const text = felder.filter(Boolean).join(' \n ').toLowerCase();
  return worte.every((w) => text.includes(w));
}
