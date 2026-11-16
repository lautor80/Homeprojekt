/**
 * Projekte – Rechenkern der Termin- und Ressourcenplanung (reine Funktionen ohne Datenbank).
 *
 * Terminplanung: Vorgänge mit Dauer in Kalendertagen (0 = Meilenstein) und Abhängigkeiten „Ende → Anfang“ mit Abstand.
 * Ein Vorgang beginnt am frühesten Beginn, den seine Vorgänger zulassen – nicht vor seinem von Hand gesetzten Beginn,
 * ohne beides mit dem Projekt. Vorwärts- und Rückwärtsrechnung liefern Puffer und den kritischen Weg.
 * Ressourcen: Arbeitseinsatz (Personen × Stunden × externer Verrechnungssatz) und Material (Menge × Einzelpreis).
 */

const TAG = 86_400_000;
/** kaufmännisch auf Cent runden – 2,5 × 19,99 = 49,975 ergibt 49,98, obwohl die Gleitkommazahl knapp darunter liegt */
const cent = (v: number) => Math.round(Number((v * 100).toPrecision(12))) / 100;
/** Tagesnummer eines Datums JJJJ-MM-TT und zurück */
export const tagNr = (iso: string) => Math.round(Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) / TAG);
export const tagIso = (nr: number) => new Date(nr * TAG).toISOString().slice(0, 10);

export interface VorgangEin {
  key: string; bezeichnung: string;
  /** frühester Beginn von Hand (JJJJ-MM-TT) oder leer */
  beginn?: string | null;
  /** Kalendertage; 0 = Meilenstein */
  dauer: number;
  vorgaenger: { key: string; abstand: number }[];
}
export interface Termin {
  /** erster und letzter Tag des Vorgangs (Meilenstein: derselbe Tag) */
  beginn: string; ende: string;
  /** Tage, um die sich der Vorgang verschieben darf, ohne das Projektende zu verschieben */
  puffer: number; kritisch: boolean;
}
export interface Terminplan { termine: Map<string, Termin>; beginn: string; ende: string; tage: number }

export class PlanungFehler extends Error {}

/**
 * Vorgänge terminieren. `start` = Beginn des Projekts (JJJJ-MM-TT). Wirft PlanungFehler bei unbekanntem Vorgänger
 * oder wenn sich Vorgänge im Kreis bedingen.
 */
export function terminieren(start: string, vorgaenge: VorgangEin[]): Terminplan {
  const s0 = tagNr(start);
  const nach = new Map(vorgaenge.map((v) => [v.key, v]));
  if (nach.size !== vorgaenge.length) throw new PlanungFehler('Zwei Vorgänge haben dieselbe Kennung.');
  for (const v of vorgaenge) {
    for (const p of v.vorgaenger) {
      if (!nach.has(p.key)) throw new PlanungFehler(`„${v.bezeichnung}“ verweist auf einen Vorgänger, den es nicht gibt.`);
      if (p.key === v.key) throw new PlanungFehler(`„${v.bezeichnung}“ kann nicht sein eigener Vorgänger sein.`);
    }
  }
  // Reihenfolge, in der jeder Vorgang nach seinen Vorgängern kommt (Kahn); bleibt etwas übrig, gibt es einen Kreis
  const offen = new Map(vorgaenge.map((v) => [v.key, new Set(v.vorgaenger.map((p) => p.key)).size]));
  const folger = new Map<string, string[]>();
  for (const v of vorgaenge) for (const p of new Set(v.vorgaenger.map((x) => x.key))) folger.set(p, [...(folger.get(p) ?? []), v.key]);
  const reihe: string[] = [];
  const bereit = vorgaenge.filter((v) => !offen.get(v.key)).map((v) => v.key);
  while (bereit.length) {
    const k = bereit.shift()!;
    reihe.push(k);
    for (const f of folger.get(k) ?? []) { offen.set(f, offen.get(f)! - 1); if (!offen.get(f)) bereit.push(f); }
  }
  if (reihe.length !== vorgaenge.length) {
    const kreis = vorgaenge.filter((v) => offen.get(v.key)).map((v) => `„${v.bezeichnung}“`);
    throw new PlanungFehler(`Die Vorgänge ${kreis.join(', ')} bedingen sich im Kreis – bitte eine Abhängigkeit entfernen.`);
  }
  // vorwärts: frühester Beginn (fb) und frühestes Ende (fe, exklusiv)
  const fb = new Map<string, number>(), fe = new Map<string, number>();
  for (const k of reihe) {
    const v = nach.get(k)!;
    let b = v.beginn ? tagNr(v.beginn) : v.vorgaenger.length ? -Infinity : s0;
    for (const p of v.vorgaenger) b = Math.max(b, fe.get(p.key)! + p.abstand);
    fb.set(k, b);
    fe.set(k, b + Math.max(0, v.dauer));
  }
  const anfang = vorgaenge.length ? Math.min(s0, ...fb.values()) : s0;
  const schluss = vorgaenge.length ? Math.max(...fe.values()) : s0;
  // rückwärts: spätestes Ende (se) – daraus der Puffer
  const se = new Map<string, number>();
  for (const k of [...reihe].reverse()) {
    let e = schluss;
    for (const f of folger.get(k) ?? []) {
      const fv = nach.get(f)!;
      const abstand = Math.max(...fv.vorgaenger.filter((p) => p.key === k).map((p) => p.abstand));
      e = Math.min(e, se.get(f)! - Math.max(0, fv.dauer) - abstand);
    }
    se.set(k, e);
  }
  const termine = new Map<string, Termin>();
  for (const v of vorgaenge) {
    const b = fb.get(v.key)!, e = fe.get(v.key)!;
    const puffer = se.get(v.key)! - e;
    termine.set(v.key, { beginn: tagIso(b), ende: tagIso(v.dauer > 0 ? e - 1 : b), puffer, kritisch: puffer <= 0 });
  }
  return { termine, beginn: tagIso(anfang), ende: tagIso(Math.max(anfang, schluss - (schluss > anfang ? 1 : 0))), tage: Math.max(1, schluss - anfang) };
}

export interface ArbeitEin { adrnr?: string | null; name: string; personen: number; stunden: number; satz?: number | null }
export interface MaterialEin { menge: number; preis: number; beschafft?: boolean }
export interface RessourcenSummen {
  /** Personenstunden und ihr Wert zum externen Verrechnungssatz (Eigenleistung – kein Geldabfluss) */
  stunden: number; eigenleistung: number;
  /** verschiedene Mitglieder bzw. Helfer */
  personen: number;
  material: number; material_beschafft: number;
}

/** Wert einer Arbeitszeile: Personen × Stunden je Person × Satz (leer = Vorgabe des Projekts) */
export const arbeitWert = (a: ArbeitEin, stundensatz: number) => cent(a.personen * a.stunden * (a.satz ?? stundensatz));
export const materialSumme = (m: MaterialEin) => cent(m.menge * m.preis);

export function ressourcenSummen(arbeit: ArbeitEin[], material: MaterialEin[], stundensatz: number): RessourcenSummen {
  const mitglieder = new Set(arbeit.filter((a) => a.adrnr).map((a) => a.adrnr));
  const freie = arbeit.filter((a) => !a.adrnr).reduce((n, a) => n + a.personen, 0);
  return {
    stunden: cent(arbeit.reduce((s, a) => s + a.personen * a.stunden, 0)),
    eigenleistung: cent(arbeit.reduce((s, a) => s + arbeitWert(a, stundensatz), 0)),
    personen: mitglieder.size + freie,
    material: cent(material.reduce((s, m) => s + materialSumme(m), 0)),
    material_beschafft: cent(material.filter((m) => m.beschafft).reduce((s, m) => s + materialSumme(m), 0)),
  };
}
