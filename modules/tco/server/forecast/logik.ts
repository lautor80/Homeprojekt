import { heute, runden } from '../format.js';
import type { Db } from '../verein.js';
import { artNorm, preiseLesen, vertragsbetrag, type Preis } from '../beitraege/logik.js';

/**
 * Beitragsforecast – Port von Z2UI5_CL_TCO_BEITRAGSFORECAST mit der Rechenlogik aus
 * ZTCO_FINANCE_REPORT=>EINNAHMEN_BERECHNEN / JAHRESEINNAHMEN_BERECHNEN.
 *
 * Je Monat gilt der Monatserste als Stichtag; gezählt werden die Verträge, die am Stichtag laufen
 * (vertragbegin <= Stichtag, vertragende leer oder >= Stichtag):
 *   Januar      alle Arten <= '90'  (Mitgliedsbeiträge, Jugendtraining – und wegen des Zeichenvergleichs
 *                                    auch dreistellige Arten wie 101 Spende, die nur im Januar gezählt wird)
 *   Juli        wie Januar ohne Art 101 (Spende)
 *   übrige      nur Art 90 (Jugendtraining, monatlich)
 * Der Betrag kommt zum Stichtag aus dem Beitragsstamm (außer individueller Betrag am Vertrag).
 * Basisjahr = gewähltes Jahr, Forecast = Folgejahr (laufende Verträge, Austritte über vertragende,
 * geplante Beitragsänderungen über die Zeiträume des Beitragsstamms), Vorjahr als Vergleichsspalte.
 */

export const MONATE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

interface Vertrag {
  adrnr: string; art: string; artname: string; betrag: number; indiv: boolean; sollstellung: string;
  beginn: string | null; ende: string | null; nachname: string; vorname: string;
}

/** Zeichenvergleich wie in ABAP (CHAR-Feld): '101' <= '90' ist wahr, '95' nicht */
const artBis90 = (art: string) => art <= '90';
export const kategorie = (art: string) => (art < '90' ? 'Mitgliedsbeitrag' : art === '90' ? 'Jugendtraining' : '');
const stichtag = (jahr: number, monat: number) => `${jahr}-${String(monat).padStart(2, '0')}-01`;
const laeuft = (v: Vertrag, d: string) => !!v.beginn && v.beginn <= d && (!v.ende || v.ende >= d);

/** Zählt die Art im Monat (Regeln aus EINNAHMEN_BERECHNEN) */
export function zaehltImMonat(art: string, monat: number): boolean {
  if (monat === 1) return artBis90(art);
  if (monat === 7) return artBis90(art) && art !== '101';
  return art === '90';
}

async function vertraegeLesen(db: Db, von: string, bis: string): Promise<Vertrag[]> {
  const r = await db`select v.adrnr, v.art, coalesce(v.artname, '') as artname, coalesce(v.betrag, 0)::float8 as betrag, v.betrag_indiv,
                            coalesce(v.sollstellung, '') as sollstellung, v.vertragbegin::text as beginn, v.vertragende::text as ende,
                            coalesce(m.nachname, '') as nachname, coalesce(m.vorname, '') as vorname
                       from tco.vertraege v left join tco.mitglieder m on m.adrnr = v.adrnr
                      where v.vertragbegin <= ${bis} and (v.vertragende is null or v.vertragende >= ${von})`;
  return r.map((x) => ({
    adrnr: x.adrnr, art: artNorm(x.art), artname: String(x.artname).trim(), betrag: Number(x.betrag), indiv: !!x.betrag_indiv,
    sollstellung: String(x.sollstellung).trim(), beginn: x.beginn, ende: x.ende, nachname: x.nachname, vorname: x.vorname,
  })).filter((v) => v.art && artBis90(v.art));
}

export interface Wert { jahr: number; monat: number; kategorie: string; art: string; artname: string; anzahl: number; wert: number }

/**
 * Beitragseinnahmen eines Jahres je Monat und Vertragsart (EINNAHMEN_BERECHNEN).
 * Abweichung zu ABAP: der Wert wird je Gruppe (Art, Bezeichnung) aus deren Verträgen summiert; ABAP
 * summiert über alle Verträge mit gleicher Bezeichnung, was bei gleicher Bezeichnung unter mehreren
 * Arten doppelt zählen würde. Bei eindeutigen Bezeichnungen ist das Ergebnis identisch.
 */
export function einnahmenBerechnen(vtr: Vertrag[], pr: Preis[], jahr: number): Wert[] {
  const out: Wert[] = [];
  for (let m = 1; m <= 12; m++) {
    const d = stichtag(jahr, m);
    const gruppen = new Map<string, Wert>();
    for (const v of vtr) {
      if (!zaehltImMonat(v.art, m) || !laeuft(v, d)) continue;
      const k = `${v.art}|${v.artname}`;
      let g = gruppen.get(k);
      if (!g) { g = { jahr, monat: m, kategorie: kategorie(v.art), art: v.art, artname: v.artname, anzahl: 0, wert: 0 }; gruppen.set(k, g); }
      g.anzahl++;
      g.wert = runden(g.wert + vertragsbetrag(pr, v.art, v.betrag, v.indiv, d));
    }
    out.push(...[...gruppen.values()].sort((a, b) => a.artname.localeCompare(b.artname, 'de') || a.art.localeCompare(b.art)));
  }
  return out;
}

const state = (delta: number) => (delta < 0 ? 'Negative' : delta > 0 ? 'Positive' : 'None') as 'Negative' | 'Positive' | 'None';

export interface MonatZeile { monat: number; mtext: string; wert0: number; wert1: number; wert2: number; delta: number; state: 'Negative' | 'Positive' | 'None' }
export interface Knoten {
  key: string; ebene: 1 | 2 | 3; kategorie: string; text: string; anzahl: number; wert0: number; wert1: number; wert2: number; delta: number;
  state: 'Negative' | 'Positive' | 'None'; preis: number | null; peinh: string;
}

/** Auswahl Basisjahr: nächstes Jahr bis fünf Jahre zurück (JAHRE_LESEN) */
export function jahreListe(): number[] {
  const akt = new Date().getFullYear();
  return [1, 2, 3, 4, 5, 6].map((i) => akt - i + 2);
}

/** Alle Daten der Seite für ein Basisjahr (DATEN_LESEN, optional MITGLIEDER_ERGAENZEN) */
export async function forecast(db: Db, jahr: number, mitMitgliedern: boolean) {
  const jahr0 = jahr - 1, jahr2 = jahr + 1;
  const pr = await preiseLesen(db);
  const vtr = await vertraegeLesen(db, `${jahr0}-01-01`, `${jahr2}-12-31`);
  const w0 = einnahmenBerechnen(vtr, pr, jahr0);
  const w1 = einnahmenBerechnen(vtr, pr, jahr);
  const w2 = einnahmenBerechnen(vtr, pr, jahr2);
  const info = !w1.length && !w2.length ? `Für ${jahr} konnten keine Beiträge ermittelt werden.` : null;

  // Monatssicht + Chartdaten
  const monate: MonatZeile[] = [];
  let s1 = 0, s2 = 0;
  for (let m = 1; m <= 12; m++) {
    const sum = (l: Wert[]) => runden(l.filter((x) => x.monat === m).reduce((s, x) => s + x.wert, 0));
    const a = sum(w0), b = sum(w1), c = sum(w2);
    monate.push({ monat: m, mtext: MONATE[m - 1], wert0: a, wert1: b, wert2: c, delta: runden(c - b), state: state(runden(c - b)) });
    s1 = runden(s1 + b);
    s2 = runden(s2 + c);
  }
  const summen = { sum1: s1, sum2: s2, delta: runden(s2 - s1), state: runden(s2 - s1) < 0 ? 'Negative' as const : 'Positive' as const };

  // Sicht je Vertragsart: Anzahl aus dem letzten gelesenen Monat des Basisjahres
  const arten = new Map<string, { kategorie: string; artname: string; art: string; anzahl: number; w0: number; w1: number; w2: number }>();
  const hole = (x: Wert) => {
    const k = `${x.kategorie}|${x.artname}`;
    let a = arten.get(k);
    if (!a) { a = { kategorie: x.kategorie, artname: x.artname, art: x.art, anzahl: 0, w0: 0, w1: 0, w2: 0 }; arten.set(k, a); }
    return a;
  };
  for (const x of w1) { const a = hole(x); a.w1 = runden(a.w1 + x.wert); a.anzahl = x.anzahl; a.art = x.art; }
  for (const x of w2) { const a = hole(x); a.w2 = runden(a.w2 + x.wert); }
  for (const x of w0) { const a = hole(x); a.w0 = runden(a.w0 + x.wert); }

  // Beitragspreis je Vertragsart: jüngster Vertrag, der im Basisjahr läuft; Betrag laut Stamm zum Jahresende, sonst Vertrag
  const von = `${jahr}-01-01`, bis = `${jahr}-12-31`;
  const juengst = new Map<string, Vertrag>();
  for (const v of [...vtr].filter((x) => !!x.beginn && x.beginn <= bis && (!x.ende || x.ende >= von)).sort((a, b) => (b.beginn ?? '').localeCompare(a.beginn ?? ''))) {
    if (!juengst.has(v.artname)) juengst.set(v.artname, v);
  }
  const preisArt = (artname: string): { preis: number | null; peinh: string } => {
    const v = juengst.get(artname);
    if (!v) return { preis: null, peinh: '' };
    const b = vertragsbetrag(pr, v.art, v.betrag, false, bis);
    return { preis: b, peinh: `EUR ${v.sollstellung}` };
  };

  const knoten: Knoten[] = [];
  const kategorien = [...new Set([...arten.values()].map((a) => a.kategorie))].sort((a, b) => a.localeCompare(b, 'de'));
  for (const k of kategorien) {
    const l = [...arten.values()].filter((a) => a.kategorie === k).sort((a, b) => a.artname.localeCompare(b.artname, 'de'));
    const ks = l.reduce((s, a) => ({ anzahl: s.anzahl + a.anzahl, w0: runden(s.w0 + a.w0), w1: runden(s.w1 + a.w1), w2: runden(s.w2 + a.w2) }), { anzahl: 0, w0: 0, w1: 0, w2: 0 });
    knoten.push({ key: k, ebene: 1, kategorie: k, text: k || 'Sonstige', anzahl: ks.anzahl, wert0: ks.w0, wert1: ks.w1, wert2: ks.w2, delta: runden(ks.w2 - ks.w1), state: state(runden(ks.w2 - ks.w1)), preis: null, peinh: '' });
    for (const a of l) {
      const p = preisArt(a.artname);
      knoten.push({ key: `${k}|${a.artname}`, ebene: 2, kategorie: k, text: a.artname, anzahl: a.anzahl, wert0: a.w0, wert1: a.w1, wert2: a.w2, delta: runden(a.w2 - a.w1), state: state(runden(a.w2 - a.w1)), preis: p.preis, peinh: p.peinh });
      if (mitMitgliedern) knoten.push(...mitgliederKnoten(vtr, pr, a.artname, k, jahr0));
    }
  }

  return {
    jahr, jahr0, jahr2, jahre: jahreListe(), info, summen, monate,
    chart: monate.map((m) => ({ label: String(m.monat).padStart(2, '0'), val1: m.wert1, val2: m.wert2 })),
    knoten, mitglieder: mitMitgliedern,
  };
}

/** Dritte Stufe: Mitglieder je Vertragsart mit Werten der drei Jahre (MITGLIEDER_ERGAENZEN) */
function mitgliederKnoten(vtr: Vertrag[], pr: Preis[], artname: string, kat: string, jahr0: number): Knoten[] {
  const h = heute();
  const m = new Map<string, { text: string; anzahl: number; betrag: number; turnus: string; w: [number, number, number] }>();
  for (const v of vtr.filter((x) => x.artname === artname)) {
    let e = m.get(v.adrnr);
    if (!e) {
      e = { text: v.nachname ? `${v.nachname}, ${v.vorname}` : `Adresse ${v.adrnr}`, anzahl: 0, betrag: 0, turnus: '', w: [0, 0, 0] };
      m.set(v.adrnr, e);
    }
    e.anzahl++;
    e.betrag = vertragsbetrag(pr, v.art, v.betrag, v.indiv, h);
    e.turnus = v.sollstellung;
    for (let j = 0; j < 3; j++) {
      let wert = 0;
      for (let mo = 1; mo <= 12; mo++) {
        const d = stichtag(jahr0 + j, mo);
        if (!laeuft(v, d) || !zaehltImMonat(v.art, mo)) continue;
        wert += vertragsbetrag(pr, v.art, v.betrag, v.indiv, d);
      }
      e.w[j] = runden(e.w[j] + wert);
    }
  }
  return [...m.entries()]
    .filter(([, e]) => e.w[0] !== 0 || e.w[1] !== 0 || e.w[2] !== 0)
    .sort((a, b) => a[1].text.localeCompare(b[1].text, 'de'))
    .map(([adrnr, e]) => ({
      key: `${kat}|${artname}|${adrnr}`, ebene: 3 as const, kategorie: kat, text: e.text, anzahl: e.anzahl,
      wert0: e.w[0], wert1: e.w[1], wert2: e.w[2], delta: runden(e.w[2] - e.w[1]), state: state(runden(e.w[2] - e.w[1])),
      preis: e.betrag, peinh: `EUR ${e.turnus}`,
    }));
}
