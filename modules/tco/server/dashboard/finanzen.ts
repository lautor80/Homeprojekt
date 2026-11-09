/**
 * Port von ZCL_TCO_FINANZEN – Fachlogik Finanzübersicht (ohne UI) auf Basis
 * tco.fibuchungen, tco.fikonten und tco.fibankab (Anfangsbestände Geldkonten).
 *
 * Kontenbereiche (numerisch):
 *   Geldkonten  1000 - 1299   Kontostand = AB + Soll - Haben
 *   Ausgaben    2001 - 7999   Wert = Soll - Haben
 *   Einnahmen   8001 - 8999   Wert = Haben - Soll (ohne Bestandskonten Kennzahl BA)
 *
 * Gewinn = Einnahmen - Ausgaben. Der Anfangsbestand wird aus dem jüngsten gepflegten
 * ANFANGSBESTAND (<= Jahr) plus den Bewegungen der Folgejahre fortgeschrieben.
 * Es wird nichts auf die Datenbank geschrieben.
 */
import type { Db } from '../verein.js';
import { heute, runden } from '../format.js';

export type Kontoart = 'G' | 'E' | 'A' | '';

export interface Geldkonto { konto: string; name: string; anfangsbestand: number; zugang: number; abgang: number; endbestand: number }
export interface Ergebnis {
  jahr: number; einnahmen: number; ausgaben: number; gewinn: number; geld_ab: number; geld_eb: number; geld_delta: number; differenz: number;
  /** Anteil am Gewinn aus Buchungen, deren Gegenkonto kein Geldkonto ist (z. B. Forderungen, Umbuchungen) */
  ohne_geld: number;
}
export interface Verlauf { jahr: number; monat: number; einnahmen: number; ausgaben: number; bestand: number; zukunft: boolean }
export interface Liquiditaet { jahr: number; monat: number; geld: number; forderung: number; ford_stand: string | null; kredit: number; liquiditaet: number }

/** Kontonummer ohne Leerzeichen und führende Nullen (ZTCO_KONTO ist CHAR4, GKONTO oft 10-stellig) */
export const kontoKey = (k: string | null | undefined) => (k ?? '').trim().replace(/^0+(?=\d)/, '');

/** Kontoart G/E/A ermitteln, '' = nicht relevant */
export function kontoart(konto: string | null | undefined, kennzahl?: string | null): Kontoart {
  const n = Number((konto ?? '').trim());
  if (!Number.isFinite(n) || (konto ?? '').trim() === '') return '';
  if (n >= 1000 && n <= 1299) return 'G';
  if (n >= 2001 && n <= 7999) return 'A';
  if (n >= 8001 && n <= 8999 && (kennzahl ?? '') !== 'BA') return 'E';
  return '';
}

interface Bew { jahr: number; konto: string; soll: number; haben: number }

/** Bestandskonten (Filter über die Kontoart bzw. Kennzahl) mit AB, Zugang, Abgang, EB im Geschäftsjahr */
async function bestandskonten(db: Db, jahr: number, passt: (konto: string, kennzahl: string | null) => boolean): Promise<Geldkonto[]> {
  const konten = await db`select konto, coalesce(name, '') as name, kennzahl from tco.fikonten order by konto`;
  // jüngster gepflegter Anfangsbestand <= Geschäftsjahr
  const ab = await db`select jahr, konto, anfangsbestand::float8 as anfangsbestand from tco.fibankab
                       where jahr <= ${jahr} and anfangsbestand is not null order by konto, jahr desc`;
  const bew = (await db`select jahr, konto, coalesce(sum(soll), 0)::float8 as soll, coalesce(sum(haben), 0)::float8 as haben
                          from tco.fibuchungen where jahr <= ${jahr} group by jahr, konto`) as unknown as Bew[];
  const out: Geldkonto[] = [];
  for (const k of konten) {
    if (!passt(k.konto, k.kennzahl)) continue;
    const g: Geldkonto = { konto: k.konto, name: k.name, anfangsbestand: 0, zugang: 0, abgang: 0, endbestand: 0 };
    let basis = 0;
    const a = ab.find((x) => x.konto === k.konto);
    if (a) { basis = Number(a.jahr); g.anfangsbestand = Number(a.anfangsbestand); }
    for (const b of bew) {
      if (b.konto !== k.konto || Number(b.jahr) < basis) continue;
      if (Number(b.jahr) < jahr) g.anfangsbestand += b.soll - b.haben;  // Jahre zwischen gepflegtem AB und Geschäftsjahr fortschreiben
      else { g.zugang += b.soll; g.abgang += b.haben; }
    }
    g.anfangsbestand = runden(g.anfangsbestand); g.zugang = runden(g.zugang); g.abgang = runden(g.abgang);
    g.endbestand = runden(g.anfangsbestand + g.zugang - g.abgang);
    if (g.anfangsbestand === 0 && g.zugang === 0 && g.abgang === 0) continue;
    out.push(g);
  }
  return out.sort((x, y) => x.konto.localeCompare(y.konto));
}

/** Kontostände aller Geldkonten im Geschäftsjahr */
export const geldkonten = (db: Db, jahr: number) => bestandskonten(db, jahr, (k, kz) => kontoart(k, kz) === 'G');

/** Salden der Kredit-/Darlehenskonten (Kennzahl BK) im Geschäftsjahr */
export const kreditkonten = (db: Db, jahr: number) => bestandskonten(db, jahr, (_k, kz) => kz === 'BK');

/** Einnahmen und Ausgaben eines Geschäftsjahres (Summe aller Monate) */
async function einnahmenAusgaben(db: Db, jahr: number): Promise<{ einnahmen: number; ausgaben: number; ohne_geld: number }> {
  const rows = await db`select b.konto, k.kennzahl, b.gkonto, g.kennzahl as gkennzahl,
                               coalesce(sum(b.soll), 0)::float8 as soll, coalesce(sum(b.haben), 0)::float8 as haben
                          from tco.fibuchungen b left join tco.fikonten k on k.konto = b.konto
                          left join tco.fikonten g on g.konto = b.gkonto
                         where b.jahr = ${jahr} group by b.konto, k.kennzahl, b.gkonto, g.kennzahl`;
  let einnahmen = 0, ausgaben = 0, ohne_geld = 0;
  for (const r of rows) {
    const art = kontoart(r.konto, r.kennzahl);
    const w = art === 'E' ? r.haben - r.soll : art === 'A' ? -(r.soll - r.haben) : 0;
    if (art === 'E') einnahmen += r.haben - r.soll;
    else if (art === 'A') ausgaben += r.soll - r.haben;
    if (art && kontoart(kontoKey(r.gkonto), r.gkennzahl) !== 'G') ohne_geld += w;
  }
  return { einnahmen: runden(einnahmen), ausgaben: runden(ausgaben), ohne_geld: runden(ohne_geld) };
}

/** Gewinn und Abgleich mit den Geldbeständen */
export async function ergebnis(db: Db, jahr: number): Promise<Ergebnis> {
  const { einnahmen, ausgaben, ohne_geld } = await einnahmenAusgaben(db, jahr);
  let geld_ab = 0, geld_eb = 0;
  for (const g of await geldkonten(db, jahr)) { geld_ab += g.anfangsbestand; geld_eb += g.endbestand; }
  const gewinn = runden(einnahmen - ausgaben);
  const geld_delta = runden(geld_eb - geld_ab);
  return { jahr, einnahmen, ausgaben, gewinn, geld_ab: runden(geld_ab), geld_eb: runden(geld_eb), geld_delta, differenz: runden(geld_delta - gewinn), ohne_geld };
}

/**
 * Verlauf je Monat für mehrere Geschäftsjahre und eine Auswahl von Geldkonten (leer = alle Geldkonten).
 * Einnahmen/Ausgaben werden über das Gegenkonto den gewählten Geldkonten zugeordnet, der Bestand ist
 * der Kontostand der gewählten Geldkonten zum Monatsende.
 */
export async function monatsverlauf(db: Db, jahre: number[], konten: string[] = []): Promise<{ verlauf: Verlauf[]; anfangsbestand: number }> {
  const js = [...new Set(jahre)].sort((a, b) => a - b);
  if (!js.length) return { verlauf: [], anfangsbestand: 0 };
  let sel = konten.map(kontoKey).filter(Boolean);
  if (!sel.length) {
    const fk = await db`select konto, kennzahl from tco.fikonten`;
    sel = fk.filter((k) => kontoart(k.konto, k.kennzahl) === 'G').map((k) => kontoKey(k.konto));
  }
  const von = js[0], bis = js[js.length - 1];
  const bu = await db`select b.jahr, b.monat, b.konto, b.gkonto, k.kennzahl, coalesce(sum(b.soll), 0)::float8 as soll, coalesce(sum(b.haben), 0)::float8 as haben
                        from tco.fibuchungen b left join tco.fikonten k on k.konto = b.konto
                       where b.jahr between ${von} and ${bis} group by b.jahr, b.monat, b.konto, b.gkonto, k.kennzahl`;
  const h = heute();
  const hj = Number(h.slice(0, 4)), hm = Number(h.slice(5, 7));
  const verlauf: Verlauf[] = [];
  let anfangsbestand = 0;
  for (const jahr of js) {
    // Anfangsbestand der gewählten Geldkonten im Jahr
    let bestand = 0;
    for (const g of await geldkonten(db, jahr)) if (sel.includes(kontoKey(g.konto))) bestand += g.anfangsbestand;
    if (jahr === von) anfangsbestand = runden(bestand);
    for (let monat = 1; monat <= 12; monat++) {
      const v: Verlauf = { jahr, monat, einnahmen: 0, ausgaben: 0, bestand: 0, zukunft: jahr > hj || (jahr === hj && monat > hm) };
      for (const b of bu) {
        if (Number(b.jahr) !== jahr || Number(b.monat) !== monat) continue;
        // Bewegung auf einem gewählten Geldkonto -> Kontostand
        if (sel.includes(kontoKey(b.konto))) { bestand += b.soll - b.haben; continue; }
        // Einnahme/Ausgabe mit gewähltem Geldkonto als Gegenkonto
        if (!sel.includes(kontoKey(b.gkonto))) continue;
        const art = kontoart(b.konto, b.kennzahl);
        if (art === 'E') v.einnahmen += b.haben - b.soll;
        else if (art === 'A') v.ausgaben += b.soll - b.haben;
      }
      v.einnahmen = runden(v.einnahmen); v.ausgaben = runden(v.ausgaben); v.bestand = runden(bestand);
      verlauf.push(v);
    }
  }
  return { verlauf, anfangsbestand };
}

/** Offene Forderungen (Clubhaus, tco.forderungen.offene_posten) zum Monat – es gilt der jüngste Stand <= Jahr/Monat */
export async function forderungen(db: Db, jahr: number, monat: number): Promise<{ betrag: number; stand: string | null }> {
  const op = await db`select jahr, monat, offene_posten::float8 as offene_posten from tco.forderungen
                       where jahr <= ${jahr} order by jahr desc, monat desc`;
  for (const o of op) {
    if (Number(o.jahr) < jahr || Number(o.monat) <= monat) {
      return { betrag: Number(o.offene_posten ?? 0), stand: `${String(o.monat).padStart(2, '0')}/${o.jahr}` };
    }
  }
  return { betrag: 0, stand: null };
}

/** Liquidität = Geldkonten + offene Forderungen + Kredite (Darlehenskonten, Saldo negativ = Schuld) */
export async function liquiditaet(db: Db, jahr: number, monat: number): Promise<Liquiditaet> {
  let geld = 0, kredit = 0;
  for (const g of await geldkonten(db, jahr)) geld += g.endbestand;
  for (const k of await kreditkonten(db, jahr)) kredit += k.endbestand;
  const f = await forderungen(db, jahr, monat);
  return { jahr, monat, geld: runden(geld), forderung: f.betrag, ford_stand: f.stand, kredit: runden(kredit), liquiditaet: runden(geld + f.betrag + kredit) };
}
