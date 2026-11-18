/**
 * Posteingang Euroflex – Absenderbaum: gruppiert die E-Mails der Liste nach eigenem Eingangspostfach (info@, buchhaltung@ …),
 * Domain und Absenderadresse, damit man sieht, in welchem Postfach die E-Mails von wem ankommen, und die Liste nach einem Knoten
 * filtern kann. Reine Funktionen ohne Oberfläche (Test: server/test/transport_absenderbaum.test.ts).
 */

/** Was der Baum aus einer Zeile braucht */
export interface AbsenderZeile { von: string | null; von_name: string | null; postfach?: string | null }

export interface AbsenderAdresse {
  /** Adresse in Kleinbuchstaben (Schlüssel) */
  adresse: string;
  /** zuletzt gesehener Anzeigename, sonst null */
  name: string | null;
  anzahl: number;
}

export interface AbsenderDomain { domain: string; anzahl: number; adressen: AbsenderAdresse[] }

/** Eigenes Eingangspostfach mit den Absendern, deren E-Mails dort ankamen */
export interface PostfachKnoten { postfach: string; bezeichnung: string; anzahl: number; domains: AbsenderDomain[] }

/** Filter der Liste als Pfad im Baum (Postfach → Domain → Adresse); jede gesetzte Angabe muss passen. null = alle */
export type AbsenderFilter = { postfach?: string; domain?: string; adresse?: string } | null;

export const OHNE_ADRESSE = '(ohne Adresse)';
export const OHNE_POSTFACH = '(ohne Postfach)';

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

/** Eingangspostfach einer Zeile in Kleinbuchstaben; leer = OHNE_POSTFACH */
export const postfachVon = (p: string | null | undefined) => (p ?? '').trim().toLowerCase() || OHNE_POSTFACH;

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

/**
 * Baum Postfach → Domain → Adresse. Postfächer in der Reihenfolge der Einstellungen (mit deren Bezeichnung), danach
 * unbekannte alphabetisch, „ohne Postfach“ zuletzt. Postfächer ohne E-Mails in der Ansicht fehlen.
 */
export function postfachBaum(zeilen: readonly AbsenderZeile[], postfaecher: readonly { adresse: string; bezeichnung: string }[] = []): PostfachKnoten[] {
  const gruppen = new Map<string, AbsenderZeile[]>();
  for (const z of zeilen) {
    const p = postfachVon(z.postfach);
    const g = gruppen.get(p);
    if (g) g.push(z); else gruppen.set(p, [z]);
  }
  const reihe = postfaecher.map((p) => p.adresse.trim().toLowerCase());
  const rang = (p: string) => (p === OHNE_POSTFACH ? Number.MAX_SAFE_INTEGER : reihe.includes(p) ? reihe.indexOf(p) : reihe.length);
  return [...gruppen].map(([postfach, zz]) => ({
    postfach,
    bezeichnung: postfaecher.find((p) => p.adresse.trim().toLowerCase() === postfach)?.bezeichnung || postfach,
    anzahl: zz.length,
    domains: absenderBaum(zz),
  })).sort((a, b) => rang(a.postfach) - rang(b.postfach) || a.postfach.localeCompare(b.postfach, 'de'));
}

/** Gibt es den Knoten des Filters im Baum (noch)? Sonst gilt der Filter nicht. */
export function filterGueltig(baum: readonly PostfachKnoten[], f: AbsenderFilter): boolean {
  if (!f) return true;
  return baum.some((p) => (!f.postfach || p.postfach === f.postfach)
    && p.domains.some((d) => (!f.domain || d.domain === f.domain) && d.adressen.some((a) => !f.adresse || a.adresse === f.adresse)));
}

/** Zeilen, die zum Filter passen */
export function absenderFiltern<Z extends AbsenderZeile>(zeilen: readonly Z[], f: AbsenderFilter): Z[] {
  if (!f) return [...zeilen];
  return zeilen.filter((z) => {
    const a = adresseVon(z.von);
    return (!f.postfach || postfachVon(z.postfach) === f.postfach)
      && (!f.domain || domainVon(a) === f.domain)
      && (!f.adresse || a === f.adresse);
  });
}

/** Ist genau dieser Knoten gewählt? */
export const gleicherFilter = (a: AbsenderFilter, b: AbsenderFilter) =>
  (a?.postfach ?? '') === (b?.postfach ?? '') && (a?.domain ?? '') === (b?.domain ?? '') && (a?.adresse ?? '') === (b?.adresse ?? '');
