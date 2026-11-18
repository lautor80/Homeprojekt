/**
 * Posteingang Euroflex – Absenderbaum: gruppiert die E-Mails der Liste nach Domain und Absenderadresse, damit man sieht,
 * von wem die E-Mails kommen, und die Liste nach einem Knoten filtern kann. Reine Funktionen ohne Oberfläche (Test:
 * server/test/transport_absenderbaum.test.ts).
 */

/** Was der Baum aus einer Zeile braucht */
export interface AbsenderZeile { von: string | null; von_name: string | null }

export interface AbsenderAdresse {
  /** Adresse in Kleinbuchstaben (Schlüssel) */
  adresse: string;
  /** zuletzt gesehener Anzeigename, sonst null */
  name: string | null;
  anzahl: number;
}

export interface AbsenderDomain { domain: string; anzahl: number; adressen: AbsenderAdresse[] }

/** Filter der Liste: ganze Domain oder eine Adresse; null = alle */
export type AbsenderFilter = { art: 'domain' | 'adresse'; wert: string } | null;

export const OHNE_ADRESSE = '(ohne Adresse)';

/** Adresse aus „von“ – auch „Name <a@b.de>“ – in Kleinbuchstaben; leer = OHNE_ADRESSE */
export function adresseVon(von: string | null | undefined): string {
  const roh = (von ?? '').trim();
  const spitz = /<([^<>]+)>/.exec(roh);
  const a = (spitz ? spitz[1] : roh).trim().toLowerCase();
  return a || OHNE_ADRESSE;
}

/** Domain einer Adresse (Teil nach dem letzten @); ohne @ die Adresse selbst */
export function domainVon(adresse: string): string {
  if (adresse === OHNE_ADRESSE) return OHNE_ADRESSE;
  const i = adresse.lastIndexOf('@');
  return i >= 0 && i < adresse.length - 1 ? adresse.slice(i + 1) : adresse;
}

const nachAnzahl = <X extends { anzahl: number }>(schluessel: (x: X) => string) => (a: X, b: X) =>
  b.anzahl - a.anzahl || schluessel(a).localeCompare(schluessel(b), 'de');

/** Baum Domain → Adresse mit Anzahl, jeweils absteigend nach Anzahl, bei Gleichstand alphabetisch */
export function absenderBaum(zeilen: readonly AbsenderZeile[]): AbsenderDomain[] {
  const domains = new Map<string, Map<string, AbsenderAdresse>>();
  for (const z of zeilen) {
    const adresse = adresseVon(z.von);
    const domain = domainVon(adresse);
    let d = domains.get(domain);
    if (!d) { d = new Map(); domains.set(domain, d); }
    const a = d.get(adresse);
    const name = z.von_name?.trim() || null;
    if (a) { a.anzahl += 1; if (name) a.name = name; } else d.set(adresse, { adresse, name, anzahl: 1 });
  }
  return [...domains].map(([domain, m]) => {
    const adressen = [...m.values()].sort(nachAnzahl((x) => x.adresse));
    return { domain, anzahl: adressen.reduce((s, a) => s + a.anzahl, 0), adressen };
  }).sort(nachAnzahl((x) => x.domain));
}

/** Gibt es den Knoten des Filters im Baum (noch)? Sonst gilt der Filter nicht. */
export function filterGueltig(baum: readonly AbsenderDomain[], f: AbsenderFilter): boolean {
  if (!f) return true;
  return f.art === 'domain' ? baum.some((d) => d.domain === f.wert) : baum.some((d) => d.adressen.some((a) => a.adresse === f.wert));
}

/** Zeilen, die zum Filter passen */
export function absenderFiltern<Z extends AbsenderZeile>(zeilen: readonly Z[], f: AbsenderFilter): Z[] {
  if (!f) return [...zeilen];
  return zeilen.filter((z) => {
    const a = adresseVon(z.von);
    return f.art === 'adresse' ? a === f.wert : domainVon(a) === f.wert;
  });
}
