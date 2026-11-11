import { heute as heuteText, runden } from '../format.js';
import type { Db } from '../verein.js';
import { anfangsbestand } from '../fi/daten.js';
import { monatsende, offeneRechnungen, offeneRechnungenJe, type OffeneRechnungen } from '../offeneposten.js';

/**
 * Einnahmen & Ausgaben – Port von ZCL_TCO_FINANZEN (Fachlogik) für Z2UI5_CL_TCO_FINANZUEBERSICHT.
 *
 * Kontenbereiche (numerisch – KONTO ist Text, „650“ wäre als Zeichenvergleich sonst > „2000“):
 *   Geldkonten  1000 – 1299   Kontostand = Anfangsbestand + Soll − Haben
 *   Ausgaben    2001 – 7999   Wert = Soll − Haben
 *   Einnahmen   8001 – 8999   Wert = Haben − Soll (ohne Bestandskonten Kennzahl BA, z. B. 8200)
 *
 * Gewinn = Einnahmen − Ausgaben (Überschuss wie im Jahresabschluss). Zum Abgleich wird die
 * Veränderung der Geldbestände ermittelt – die Differenz entsteht durch Tilgungen, Geldtransit usw.
 *
 * Abweichung zu SAP: der Anfangsbestand eines Geldkontos kommt aus der gemeinsamen Saldenrechnung
 * `anfangsbestand()` in fi/daten.ts (gepflegter Anfangsbestand, sonst Endbestand des Vorjahres,
 * sonst fortgeschrieben aus dem jüngsten gepflegten Anfangsbestand). SAP ignorierte den Endbestand.
 * Es wird nichts auf die Datenbank geschrieben.
 */

export type Art = 'G' | 'E' | 'A' | '';
const GELD: [number, number] = [1000, 1299];
const AUSG: [number, number] = [2001, 7999];
const EINN: [number, number] = [8001, 8999];

export const MONATE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

/** Kontoart G/E/A ermitteln, '' = nicht relevant (KONTOART) */
export function kontoart(konto: string, kennzahl: string | null | undefined): Art {
  const k = konto.trim();
  if (!/^\d+$/.test(k)) return '';
  const n = Number(k);
  if (n >= GELD[0] && n <= GELD[1]) return 'G';
  if (n >= AUSG[0] && n <= AUSG[1]) return 'A';
  if (n >= EINN[0] && n <= EINN[1] && kennzahl !== 'BA') return 'E';
  return '';
}

interface Buch { jahr: number; monat: number; konto: string; kennzahl: string | null; name: string; soll: number; haben: number }

/** Summen je Jahr/Monat/Konto mit Kennzahl und Bezeichnung (BUCHUNGEN_LESEN) */
async function buchungenLesen(db: Db, von: number, bis: number): Promise<Buch[]> {
  const rows = await db`
    select b.jahr, b.monat, b.konto, k.kennzahl, coalesce(k.name, '') as name,
           coalesce(sum(coalesce(b.soll, 0)), 0)::float8 as soll, coalesce(sum(coalesce(b.haben, 0)), 0)::float8 as haben
      from tco.fibuchungen b left join tco.fikonten k on k.konto = b.konto
     where b.jahr between ${von} and ${bis}
     group by b.jahr, b.monat, b.konto, k.kennzahl, k.name`;
  return rows.map((r) => ({ jahr: Number(r.jahr), monat: Number(r.monat), konto: String(r.konto).trim(), kennzahl: r.kennzahl, name: r.name, soll: r.soll, haben: r.haben }));
}

/** Wert aus Sicht der Kontoart (Einnahme positiv, Ausgabe positiv) (WERT) */
const wert = (b: Buch, art: Art) => (art === 'E' ? b.haben - b.soll : b.soll - b.haben);

export interface Monat { monat: number; einnahmen: number; ausgaben: number; ergebnis: number; kumuliert: number }

/** Einnahmen/Ausgaben je Monat – immer 12 Zeilen (MONATSWERTE) */
export async function monatswerte(db: Db, jahr: number): Promise<Monat[]> {
  const m: Monat[] = Array.from({ length: 12 }, (_, i) => ({ monat: i + 1, einnahmen: 0, ausgaben: 0, ergebnis: 0, kumuliert: 0 }));
  for (const b of await buchungenLesen(db, jahr, jahr)) {
    const art = kontoart(b.konto, b.kennzahl);
    if (art !== 'E' && art !== 'A') continue;
    const z = m[b.monat - 1];
    if (!z) continue;
    if (art === 'E') z.einnahmen += wert(b, art); else z.ausgaben += wert(b, art);
  }
  let kum = 0;
  for (const z of m) {
    z.einnahmen = runden(z.einnahmen); z.ausgaben = runden(z.ausgaben);
    z.ergebnis = runden(z.einnahmen - z.ausgaben);
    kum = runden(kum + z.ergebnis);
    z.kumuliert = kum;
  }
  return m;
}

export interface Jahr { jahr: number; einnahmen: number; ausgaben: number; ergebnis: number }

/** Einnahmen/Ausgaben je Geschäftsjahr (JAHRESWERTE) */
export async function jahreswerte(db: Db, von: number, bis: number): Promise<Jahr[]> {
  const j: Jahr[] = [];
  for (let y = von; y <= bis; y++) j.push({ jahr: y, einnahmen: 0, ausgaben: 0, ergebnis: 0 });
  for (const b of await buchungenLesen(db, von, bis)) {
    const art = kontoart(b.konto, b.kennzahl);
    if (art !== 'E' && art !== 'A') continue;
    const z = j.find((x) => x.jahr === b.jahr);
    if (!z) continue;
    if (art === 'E') z.einnahmen += wert(b, art); else z.ausgaben += wert(b, art);
  }
  for (const z of j) { z.einnahmen = runden(z.einnahmen); z.ausgaben = runden(z.ausgaben); z.ergebnis = runden(z.einnahmen - z.ausgaben); }
  return j;
}

export interface KontoWert { art: 'E' | 'A'; konto: string; name: string; wert: number; wert_vj: number }

/** Einnahmen/Ausgaben je Konto mit Vorjahr (KONTOWERTE) – sortiert Einnahmen zuerst, dann Konto */
export async function kontowerte(db: Db, jahr: number): Promise<KontoWert[]> {
  const map = new Map<string, KontoWert>();
  for (const b of await buchungenLesen(db, jahr - 1, jahr)) {
    const art = kontoart(b.konto, b.kennzahl);
    if (art !== 'E' && art !== 'A') continue;
    let k = map.get(b.konto);
    if (!k) { k = { art, konto: b.konto, name: b.name, wert: 0, wert_vj: 0 }; map.set(b.konto, k); }
    if (b.jahr === jahr) k.wert += wert(b, art); else k.wert_vj += wert(b, art);
  }
  return [...map.values()]
    .map((k) => ({ ...k, wert: runden(k.wert), wert_vj: runden(k.wert_vj) }))
    .sort((a, b) => (a.art === b.art ? Number(a.konto) - Number(b.konto) : a.art === 'E' ? -1 : 1));
}

export interface Geld { konto: string; name: string; anfangsbestand: number; zugang: number; abgang: number; endbestand: number }

/**
 * Bestände je Konto im Geschäftsjahr: Anfangsbestand aus der Saldenrechnung (fi/daten.ts),
 * Zugang = Soll, Abgang = Haben des Jahres. Konten ohne Bestand und Bewegung entfallen.
 */
async function bestaende(db: Db, jahr: number, filter: (konto: string, kennzahl: string | null) => boolean): Promise<Geld[]> {
  const konten = await db`select konto, coalesce(name, '') as name, kennzahl from tco.fikonten`;
  const bew = await db`
    select konto, coalesce(sum(coalesce(soll, 0)), 0)::float8 as soll, coalesce(sum(coalesce(haben, 0)), 0)::float8 as haben
      from tco.fibuchungen where jahr = ${jahr} group by konto`;
  const bewMap = new Map<string, { soll: number; haben: number }>(bew.map((b) => [String(b.konto).trim(), { soll: Number(b.soll), haben: Number(b.haben) }]));
  const out: Geld[] = [];
  for (const k of konten) {
    const konto = String(k.konto).trim();
    if (!filter(konto, k.kennzahl)) continue;
    const ab = (await anfangsbestand(db, konto, jahr)).betrag;
    const b = bewMap.get(konto);
    const zugang = runden(b?.soll ?? 0), abgang = runden(b?.haben ?? 0);
    if (ab === 0 && zugang === 0 && abgang === 0) continue;
    out.push({ konto, name: k.name, anfangsbestand: ab, zugang, abgang, endbestand: runden(ab + zugang - abgang) });
  }
  return out.sort((a, b) => Number(a.konto) - Number(b.konto) || a.konto.localeCompare(b.konto));
}

/** Kontostände aller Geldkonten (1000–1299) im Geschäftsjahr (GELDKONTEN) */
export const geldkonten = (db: Db, jahr: number) => bestaende(db, jahr, (k, kz) => kontoart(k, kz) === 'G');

/** Salden der Kredit-/Darlehenskonten (Kennzahl BK) im Geschäftsjahr (KREDITKONTEN) */
export const kreditkonten = (db: Db, jahr: number) => bestaende(db, jahr, (_k, kz) => kz === 'BK');

/** Offene Forderungen Clubhaus zum Monat – jüngster Stand <= Jahr/Monat (FORDERUNGEN) */
export async function forderungen(db: Db, jahr: number, monat: number): Promise<{ betrag: number; stand: string }> {
  const [r] = await db`
    select coalesce(offene_posten, 0)::float8 as op, jahr, monat from tco.forderungen
     where jahr < ${jahr} or (jahr = ${jahr} and monat <= ${monat})
     order by jahr desc, monat desc limit 1`;
  if (!r) return { betrag: 0, stand: '' };
  return { betrag: runden(r.op), stand: `${String(r.monat).padStart(2, '0')}/${r.jahr}` };
}

export interface Liquiditaet {
  jahr: number; monat: number; geld: number; forderung: number; ford_stand: string; kredit: number; liquiditaet: number;
  /** nicht bezahlte Rechnungen (Halle, Verzehr, Beitragsläufe) – #28 */
  rechnungen: OffeneRechnungen;
}

/** Liquidität = Geldkonten + offene Forderungen Clubhaus + nicht bezahlte Rechnungen (#28) + Kredite (Saldo negativ = Schuld) (LIQUIDITAET) */
export async function liquiditaet(db: Db, jahr: number, monat: number): Promise<Liquiditaet> {
  const geld = runden((await geldkonten(db, jahr)).reduce((s, g) => s + g.endbestand, 0));
  const kredit = runden((await kreditkonten(db, jahr)).reduce((s, g) => s + g.endbestand, 0));
  const f = await forderungen(db, jahr, monat);
  const rechnungen = await offeneRechnungen(db, monatsende(jahr, monat, heuteText()));
  return { jahr, monat, geld, forderung: f.betrag, ford_stand: f.stand, kredit, rechnungen, liquiditaet: runden(geld + f.betrag + rechnungen.summe + kredit) };
}

export interface Ergebnis {
  jahr: number; einnahmen: number; ausgaben: number; gewinn: number;
  geld_ab: number; geld_eb: number; geld_delta: number; differenz: number; letzte_bu: string | null;
}

/** Gewinn und Abgleich mit den Geldbeständen (ERGEBNIS) */
export async function ergebnis(db: Db, jahr: number, monate?: Monat[], geld?: Geld[]): Promise<Ergebnis> {
  const m = monate ?? await monatswerte(db, jahr);
  const g = geld ?? await geldkonten(db, jahr);
  const einnahmen = runden(m.reduce((s, x) => s + x.einnahmen, 0));
  const ausgaben = runden(m.reduce((s, x) => s + x.ausgaben, 0));
  const gewinn = runden(einnahmen - ausgaben);
  const geld_ab = runden(g.reduce((s, x) => s + x.anfangsbestand, 0));
  const geld_eb = runden(g.reduce((s, x) => s + x.endbestand, 0));
  const geld_delta = runden(geld_eb - geld_ab);
  const [l] = await db`select max(datum)::text as d from tco.fibuchungen where jahr = ${jahr}`;
  return { jahr, einnahmen, ausgaben, gewinn, geld_ab, geld_eb, geld_delta, differenz: runden(geld_delta - gewinn), letzte_bu: l?.d ?? null };
}

/** offen: noch nicht bezahlte Rechnungen zum Monatsende (#28) – nur für vergangene/laufende Monate */
export interface Verlauf { jahr: number; monat: number; einnahmen: number; ausgaben: number; bestand: number; zukunft: boolean; offen: number }

/**
 * Verlauf je Monat für mehrere Geschäftsjahre und eine Auswahl von Geldkonten (leer = alle
 * Geldkonten). Einnahmen/Ausgaben werden über das Gegenkonto den gewählten Geldkonten zugeordnet,
 * Bewegungen auf den gewählten Geldkonten fortgeschriebenen Kontostand (MONATSVERLAUF).
 */
export async function monatsverlauf(db: Db, jahre: number[], konten: string[]): Promise<{ verlauf: Verlauf[]; anfangsbestand: number }> {
  const js = [...new Set(jahre)].sort((a, b) => a - b);
  if (!js.length) return { verlauf: [], anfangsbestand: 0 };
  let sel = konten.map((k) => k.trim()).filter(Boolean);
  if (!sel.length) {
    const fk = await db`select konto, kennzahl from tco.fikonten`;
    sel = fk.filter((k) => kontoart(String(k.konto).trim(), k.kennzahl) === 'G').map((k) => String(k.konto).trim());
  }
  const selSet = new Set(sel);
  const von = js[0], bis = js[js.length - 1];
  const bu = await db`
    select b.jahr, b.monat, b.konto, b.gkonto, k.kennzahl,
           coalesce(sum(coalesce(b.soll, 0)), 0)::float8 as soll, coalesce(sum(coalesce(b.haben, 0)), 0)::float8 as haben
      from tco.fibuchungen b left join tco.fikonten k on k.konto = b.konto
     where b.jahr between ${von} and ${bis}
     group by b.jahr, b.monat, b.konto, b.gkonto, k.kennzahl`;
  const heute = new Date();
  const hj = heute.getFullYear(), hm = heute.getMonth() + 1;
  const verlauf: Verlauf[] = [];
  let anfang = 0;
  const ht = heuteText();
  const offen = await offeneRechnungenJe(db, js.flatMap((j) => Array.from({ length: 12 }, (_x, i) => monatsende(j, i + 1, ht))));
  for (const jahr of js) {
    // Anfangsbestand der gewählten Geldkonten im Jahr
    let bestand = 0;
    for (const g of await geldkonten(db, jahr)) if (selSet.has(g.konto)) bestand = runden(bestand + g.anfangsbestand);
    if (jahr === von) anfang = bestand;
    for (let monat = 1; monat <= 12; monat++) {
      const zukunft = jahr > hj || (jahr === hj && monat > hm);
      const v: Verlauf = { jahr, monat, einnahmen: 0, ausgaben: 0, bestand: 0, zukunft, offen: zukunft ? 0 : offen.get(monatsende(jahr, monat, ht))?.summe ?? 0 };
      for (const b of bu) {
        if (Number(b.jahr) !== jahr || Number(b.monat) !== monat) continue;
        const konto = String(b.konto).trim();
        if (selSet.has(konto)) { bestand = runden(bestand + b.soll - b.haben); continue; }
        const gk = String(b.gkonto ?? '').replace(/^0+/, '').trim();
        if (!selSet.has(gk)) continue;
        const art = kontoart(konto, b.kennzahl);
        if (art === 'E') v.einnahmen = runden(v.einnahmen + b.haben - b.soll);
        else if (art === 'A') v.ausgaben = runden(v.ausgaben + b.soll - b.haben);
      }
      v.bestand = bestand;
      verlauf.push(v);
    }
  }
  return { verlauf, anfangsbestand: anfang };
}

/** Geschäftsjahre mit Buchungen, absteigend; das aktuelle Jahr immer dabei (JAHRE_LESEN) */
export async function jahreLesen(db: Db): Promise<number[]> {
  const rows = await db`select distinct jahr from tco.fibuchungen where jahr is not null`;
  const s = new Set<number>(rows.map((r) => Number(r.jahr)));
  s.add(new Date().getFullYear());
  return [...s].filter(Boolean).sort((a, b) => b - a);
}

/** Alles für die Seite „Einnahmen und Ausgaben“ eines Geschäftsjahres (DATEN_LESEN) */
export async function uebersicht(db: Db, jahr: number) {
  const monate = await monatswerte(db, jahr);
  const geld = await geldkonten(db, jahr);
  const erg = await ergebnis(db, jahr, monate, geld);
  const heute = new Date();
  const liqMonat = jahr === heute.getFullYear() ? heute.getMonth() + 1 : 12;
  const jahre: (Jahr & { geld_eb: number })[] = [];
  for (const j of (await jahreswerte(db, jahr - 4, jahr)).sort((a, b) => b.jahr - a.jahr)) {
    const g = j.jahr === jahr ? geld : await geldkonten(db, j.jahr);
    jahre.push({ ...j, geld_eb: runden(g.reduce((s, x) => s + x.endbestand, 0)) });
  }
  const konten = await kontowerte(db, jahr);
  return {
    jahr, monate, ergebnis: erg, geldkonten: geld, jahre,
    einnahmen: konten.filter((k) => k.art === 'E'), ausgaben: konten.filter((k) => k.art === 'A'),
    liquiditaet: await liquiditaet(db, jahr, liqMonat),
    info: erg.einnahmen === 0 && erg.ausgaben === 0 ? `Für ${jahr} liegen keine Buchungen vor.` : null,
  };
}
