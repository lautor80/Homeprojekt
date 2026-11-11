import { runden } from '../format.js';
import type { Db } from '../verein.js';
import { anfangsbestand, kontostand } from '../fi/daten.js';
import { offeneRechnungen } from '../offeneposten.js';
import { anlagenLesen, spiegelBerechnen, type Spiegel, type SpiegelSumme } from './anlagen.js';

/**
 * Jahresabschluss – Port von Z2UI5_CL_TCO_JAHRESABSCHLUSS mit der Datenermittlung aus
 * ZTCO_FINANCE_REPORT=>JAHRESABSCHLUSS_DURCHFUEHREN.
 * Gliederung über tco.fikonten.kennzahl:
 *   A1/A2  Ideeller Tätigkeitsbereich  Einnahmen/Ausgaben
 *   B1/B2  Vermögensverwaltung
 *   C1/C2  Zweckbetrieb
 *   D1/D2  Wirtschaftlicher Geschäftsbetrieb
 *   BA/BK  Bankkonten und Darlehen – nicht Teil der EAR (Vermögensübersicht)
 */

export const BEREICHE = ['A', 'B', 'C', 'D'] as const;
export type Bereich = (typeof BEREICHE)[number];
export const BEREICH_NAME: Record<Bereich, string> = {
  A: 'Ideeller Tätigkeitsbereich', B: 'Vermögensverwaltung', C: 'Zweckbetrieb', D: 'Wirtschaftlicher Geschäftsbetrieb',
};
export const bereichText = (b: Bereich) => `${b} ${BEREICH_NAME[b]}`;

/**
 * Konto, dessen Jahreswert nur aus der Haben-Seite gebildet wird (wie im SAP-Report fest
 * hinterlegt: Soll-Buchungen auf diesem Erlöskonto zählen nicht gegen).
 */
export const KONTO_NUR_HABEN = '8012';

/** Jahreswert eines Kontos (Betrag ohne Vorzeichen, Verrechnungskonten bereits verdichtet) */
export interface Jahreswert { jahr: number; konto: string; kennzahl: string | null; name: string; wert: number }

interface KontoStamm { konto: string; name: string; kennzahl: string | null; verrechnung: string | null }

export async function kontenStamm(db: Db): Promise<Map<string, KontoStamm>> {
  const r = await db`select konto, coalesce(name, '') as name, nullif(trim(coalesce(kennzahl, '')), '') as kennzahl,
                            nullif(trim(coalesce(verrechnung, '')), '') as verrechnung from tco.fikonten`;
  return new Map(r.map((k) => [k.konto, k as unknown as KontoStamm]));
}

/**
 * Jahreswerte je Konto für die Jahre von..bis (Summe Soll/Haben je Jahr und Konto):
 * Konten mit Verrechnungskonto werden auf dieses verdichtet (Gas/Wasser/Strom),
 * Betrag = |Soll − Haben| (Konto 8012: Haben). Konten ohne Stammsatz behalten ihre Nummer als Namen.
 */
export async function jahreswerteLesen(db: Db, von: number, bis: number): Promise<{ werte: Jahreswert[]; ohneStamm: string[] }> {
  const stamm = await kontenStamm(db);
  const rows = await db`
    select coalesce(jahr, extract(year from datum)::int) as jahr, konto, coalesce(sum(soll), 0)::float8 as soll, coalesce(sum(haben), 0)::float8 as haben
      from tco.fibuchungen
     where coalesce(jahr, extract(year from datum)::int) between ${von} and ${bis}
     group by 1, 2 order by 1, 2`;
  const map = new Map<string, Jahreswert>();
  const ohne = new Set<string>();
  for (const r of rows) {
    const s = stamm.get(r.konto);
    if (!s) ohne.add(r.konto);
    const konto = s?.verrechnung && stamm.has(s.verrechnung) ? s.verrechnung : r.konto;
    const k = stamm.get(konto);
    const key = `${r.jahr}|${konto}`;
    const jw = map.get(key) ?? { jahr: Number(r.jahr), konto, kennzahl: k?.kennzahl ?? null, name: k?.name || konto, wert: 0 };
    const betrag = konto === KONTO_NUR_HABEN ? Number(r.haben) : Number(r.soll) - Number(r.haben);
    jw.wert = runden(jw.wert + Math.abs(betrag));
    map.set(key, jw);
  }
  const werte = [...map.values()].sort((a, b) => a.jahr - b.jahr || a.konto.localeCompare(b.konto));
  return { werte, ohneStamm: [...ohne].sort() };
}

const summe = (jw: Jahreswert[], jahr: number, kennzahl: string) =>
  runden(jw.filter((x) => x.jahr === jahr && x.kennzahl === kennzahl).reduce((s, x) => s + x.wert, 0));

// ---------------------------------------------------------------------------
// Einnahmen-Ausgaben-Rechnung des Jahres
// ---------------------------------------------------------------------------

export interface EarKonto { konto: string; name: string; wert: number }
export interface EarBereich { bereich: Bereich; text: string; einnahmen: EarKonto[]; ausgaben: EarKonto[]; ein: number; aus: number; ergebnis: number }
export interface Ear { bereiche: EarBereich[]; ein: number; aus: number; ergebnis: number; leer: boolean }

export function earBerechnen(jw: Jahreswert[], jahr: number): Ear {
  const j = jw.filter((x) => x.jahr === jahr);
  const konten = (kz: string): EarKonto[] =>
    j.filter((x) => x.kennzahl === kz && x.wert !== 0).map((x) => ({ konto: x.konto, name: x.name, wert: x.wert }));
  const bereiche: EarBereich[] = BEREICHE.map((b) => {
    const einnahmen = konten(`${b}1`), ausgaben = konten(`${b}2`);
    const ein = runden(einnahmen.reduce((s, x) => s + x.wert, 0));
    const aus = runden(ausgaben.reduce((s, x) => s + x.wert, 0));
    return { bereich: b, text: bereichText(b), einnahmen, ausgaben, ein, aus, ergebnis: runden(ein - aus) };
  });
  const ein = runden(bereiche.reduce((s, b) => s + b.ein, 0));
  const aus = runden(bereiche.reduce((s, b) => s + b.aus, 0));
  return { bereiche, ein, aus, ergebnis: runden(ein - aus), leer: !j.length };
}

// ---------------------------------------------------------------------------
// Überschussrechnung mit Vorjahresvergleich (gewähltes Jahr und zwei Vorjahre)
// ---------------------------------------------------------------------------

export interface UebKonto { konto: string; name: string; werte: number[] }
export interface UebArt { art: '1' | '2'; text: 'Einnahmen' | 'Ausgaben'; konten: UebKonto[]; summe: number[] }
export interface UebBereich { bereich: Bereich; text: string; ein: number[]; aus: number[]; ergebnis: number[] }
export interface Ueberschuss { jahre: number[]; arten: UebArt[]; bereiche: UebBereich[]; ein: number[]; aus: number[]; ergebnis: number[] }

export function ueberschussBerechnen(jw: Jahreswert[], jahr: number): Ueberschuss {
  const jahre = [jahr, jahr - 1, jahr - 2];
  const bereiche: UebBereich[] = BEREICHE.map((b) => {
    const ein = jahre.map((j) => summe(jw, j, `${b}1`));
    const aus = jahre.map((j) => summe(jw, j, `${b}2`));
    return { bereich: b, text: bereichText(b), ein, aus, ergebnis: ein.map((e, i) => runden(e - aus[i])) };
  });
  const add = (a: number[], b: number[]) => a.map((x, i) => runden(x + b[i]));
  const ein = bereiche.reduce((s, b) => add(s, b.ein), [0, 0, 0]);
  const aus = bereiche.reduce((s, b) => add(s, b.aus), [0, 0, 0]);
  // Konten je Art über alle Tätigkeitsbereiche und die drei Jahre verdichten
  const arten: UebArt[] = (['1', '2'] as const).map((art) => {
    const m = new Map<string, UebKonto>();
    for (const x of jw) {
      if (!x.kennzahl || x.kennzahl.length < 2 || !BEREICHE.includes(x.kennzahl[0] as Bereich) || x.kennzahl[1] !== art) continue;
      const i = jahre.indexOf(x.jahr);
      if (i < 0) continue;
      const k = m.get(x.konto) ?? { konto: x.konto, name: x.name, werte: [0, 0, 0] };
      k.werte[i] = runden(k.werte[i] + x.wert);
      m.set(x.konto, k);
    }
    const konten = [...m.values()].filter((k) => k.werte.some((w) => w !== 0)).sort((a, b) => a.konto.localeCompare(b.konto));
    return { art, text: art === '1' ? 'Einnahmen' : 'Ausgaben', konten, summe: konten.reduce((s, k) => add(s, k.werte), [0, 0, 0]) };
  });
  return { jahre, arten, bereiche, ein, aus, ergebnis: ein.map((e, i) => runden(e - aus[i])) };
}

// ---------------------------------------------------------------------------
// Vermögensübersicht: Bankkonten und Darlehen (BA/BK) mit Anfangs- und Endbestand
// ---------------------------------------------------------------------------

export interface Bankbestand { jahr: number; konto: string; name: string; kennzahl: string; anfang: number; ende: number; delta: number; quelle: string }

/**
 * Anfangsbestand und Endbestand je Geldkonto über die Saldenrechnung der FI-Belege
 * (eine einzige Rechnung für Kontoauszug, Bankabgleich und Jahresabschluss).
 * Konten ohne Bestand und ohne Bewegung im Jahr entfallen.
 */
export async function bankBestaende(db: Db, jahr: number): Promise<Bankbestand[]> {
  const stamm = await kontenStamm(db);
  const out: Bankbestand[] = [];
  for (const k of [...stamm.values()].filter((x) => x.kennzahl === 'BA' || x.kennzahl === 'BK').sort((a, b) => a.konto.localeCompare(b.konto))) {
    const ab = await anfangsbestand(db, k.konto, jahr);
    const ende = await kontostand(db, k.konto, `${jahr}-12-31`);
    const [n] = await db`select count(*)::int as n from tco.fibuchungen where konto = ${k.konto} and coalesce(jahr, extract(year from datum)::int) = ${jahr}`;
    if (!n.n && ab.betrag === 0 && ende === 0) continue;
    out.push({ jahr, konto: k.konto, name: k.name || k.konto, kennzahl: k.kennzahl!, anfang: ab.betrag, ende, delta: runden(ende - ab.betrag), quelle: ab.quelle });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Gesamtbild für Oberfläche und PDF
// ---------------------------------------------------------------------------

export interface Abschluss {
  jahr: number;
  jahre: number[];
  ear: Ear;
  ueberschuss: Ueberschuss;
  bank: Bankbestand[];
  anlagen: { spiegel: Spiegel[]; summe: SpiegelSumme; leer: boolean };
  hinweise: string[];
}

/** Geschäftsjahre mit Buchungen, absteigend (mindestens das aktuelle) */
export async function jahreLesen(db: Db): Promise<number[]> {
  const r = await db`select distinct coalesce(jahr, extract(year from datum)::int) as jahr from tco.fibuchungen where coalesce(jahr, extract(year from datum)::int) is not null order by 1 desc`;
  const jahre = r.map((x) => Number(x.jahr));
  const h = new Date().getFullYear();
  if (!jahre.includes(h)) jahre.unshift(h);
  return jahre.sort((a, b) => b - a);
}

export async function abschlussLesen(db: Db, jahr: number): Promise<Abschluss> {
  const { werte, ohneStamm } = await jahreswerteLesen(db, jahr - 2, jahr);
  const ear = earBerechnen(werte, jahr);
  const ueberschuss = ueberschussBerechnen(werte, jahr);
  const bank = await bankBestaende(db, jahr);
  const alle = await anlagenLesen(db);
  const { spiegel, summe } = spiegelBerechnen(alle, jahr);
  const hinweise: string[] = [];
  if (ear.leer) hinweise.push(`Für ${jahr} liegen keine Buchungen vor.`);
  const ohneKz = [...new Set(werte.filter((w) => w.jahr === jahr && !w.kennzahl && w.wert !== 0).map((w) => w.konto))];
  if (ohneKz.length) hinweise.push(`Konten ohne Kennzahl im Kontenstamm (nicht in der EAR enthalten): ${ohneKz.join(', ')}.`);
  if (ohneStamm.length) hinweise.push(`Buchungen auf Konten ohne Kontenstamm: ${ohneStamm.join(', ')}.`);
  // nicht bezahlte Rechnungen zum Jahresende (#28): in der EAR richtig nicht enthalten (Zuflussprinzip) – zur Information
  const op = await offeneRechnungen(db, `${jahr}-12-31`);
  if (op.summe > 0) {
    const de = (v: number) => v.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    hinweise.push(`Zum 31.12.${jahr} nicht bezahlte Rechnungen: ${de(op.summe)} EUR (Halle ${de(op.halle)}, Verzehr ${de(op.verzehr)}, Beitragsläufe ${de(op.beitraege)}) – `
      + 'in der Einnahmen-Ausgaben-Rechnung nicht enthalten, sie zählen erst mit dem Zahlungseingang.');
  }
  return { jahr, jahre: await jahreLesen(db), ear, ueberschuss, bank, anlagen: { spiegel, summe, leer: !alle.length }, hinweise };
}
