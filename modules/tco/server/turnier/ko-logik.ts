/**
 * Turniere – Modus „ko“: reine Logik ohne Datenbank (auch von der Oberfläche für Typen nutzbar).
 *
 * Hauptfeld
 *  - Feldgröße N = nächste Zweierpotenz ≥ Anzahl (4 … 64). Linien 0 … N-1, Spiel pos p der 1. Runde = Linien 2p (Seite a) und 2p+1 (b).
 *  - Setzschema (linienReihenfolge): 1 oben (Linie 0), 2 unten (Linie N-1), 3/4 gelost in die freien Viertel, 5–8 in die freien
 *    Achtel, 9–16 in die freien Sechzehntel usw. Innerhalb des Abschnitts sitzt der Gesetzte am Rand: Viertel (3/4) und
 *    Sechzehntel (9–16) in der oberen Hälfte oben, in der unteren unten; Achtel (5–8) umgekehrt (32er-Feld: 1, 32, 9/24, 8/16/17/25 –
 *    wie im üblichen ITF-Schema). Die Reihenfolge wird bis zu N/2 „Vorzugsplätzen“ fortgesetzt; jeder liegt in einem anderen Spiel.
 *  - Freilose: die ersten B Vorzugsplätze (B = N - Anzahl) bekommen ein Freilos (Gegenlinie bleibt leer). Gesetzte belegen ihre
 *    Plätze in Setzreihenfolge; gibt es mehr Freilose als Gesetzte, erhalten die nächststärksten Ungesetzten die übrigen
 *    Freilos-Plätze (welcher davon welchen, wird gelost). Alle anderen werden auf die freien Linien gelost.
 *  - Sieger von (Runde r, pos p) → (r+1, ⌊p/2⌋), Seite a bei geradem p, sonst b.
 *
 * Nebenrunde (feld 'neben'); Verlierer aus Halbfinale und Finale des Hauptfelds steigen nie ein (Platz 2–4), d. h. es zählen nur
 * Hauptrunden ≤ k-2 (k = Anzahl Hauptrunden). Ein 4er-Feld hat also keine Nebenrunde.
 *  - 'erste_runde': Teilnehmende = Verlierer ihres ersten echten Spiels: alle Verlierer echter Spiele der 1. Runde und – falls die
 *    2. Runde noch zählt – Verlierer der 2. Runde, die dort nach einem Freilos ihr erstes Spiel hatten (bedingte Plätze: gewinnt der
 *    Freilos-Spieler, bleibt der Platz leer). Plätze in Reihenfolge des Hauptfelds; Feldgröße = nächste Zweierpotenz der möglichen
 *    Plätze, Freilose nach demselben Schema (feste Reihenfolge, nicht gelost), sichere Plätze bekommen die Freilose zuerst.
 *  - 'alle' (Feed-in): Runde 1 = Verlierer der 1. Hauptrunde paarweise (Spiel 2i gegen 2i+1, leer bei Freilos). Danach für jede
 *    Hauptrunde r = 2 … k-2 eine Einstiegsrunde (Sieger der Nebenrunde gegen die Verlierer der Hauptrunde r, in umgekehrter
 *    Reihenfolge, damit sich Erstrundengegner nicht sofort wieder treffen) und anschließend eine normale Runde. Zum Schluss
 *    normale Runden bis zum Finale. 16er-Feld: 4 Spiele (R1-Verlierer) → 4 Einstiegsspiele (R2-Verlierer) → Halbfinale → Finale.
 *
 * Alles Weitere (Weiterrücken, Freilose in der Nebenrunde, Zurücknehmen nach Korrektur) ergibt sich aus einem Abgleich: Aus der
 * Struktur und den gewerteten Spielen wird der Sollzustand aller Spiele berechnet (abgleichen); weicht ein bereits gewertetes Spiel
 * davon ab, ist das ein Konflikt (Folgespiel schon gespielt).
 */
import type { Satz, Seite, Wertung } from './typen.js';
import { gewertet } from './wertung.js';

export type KoFeld = 'haupt' | 'neben';
export type Nebenrunde = 'keine' | 'erste_runde' | 'alle';
export interface Ort { feld: KoFeld; runde: number; pos: number }
export type Quelle =
  | { art: 'start'; id: number | null }
  | { art: 'leer' }
  | { art: 'sieger'; von: Ort }
  /** nurNachFreilos: zählt nur, wenn der Verlierer in der 1. Runde ein Freilos hatte (Nebenrunde „erste Runde“) */
  | { art: 'verlierer'; von: Ort; nurNachFreilos?: boolean };
export interface StrukturSpiel extends Ort { a: Quelle; b: Quelle }
export interface StrukturRunde { feld: KoFeld; runde: number; titel: string; spiele: number; /** Einstieg der Verlierer dieser Hauptrunde */ einstieg: number | null }
export interface Struktur { feld: number; nebenrunde: Nebenrunde; spiele: StrukturSpiel[]; runden: StrukturRunde[] }

export const MAX_FELD = 64;
export const schluessel = (o: Ort) => `${o.feld}|${o.runde}|${o.pos}`;

/** nächste Zweierpotenz ≥ n, mindestens min */
export function zweierpotenz(n: number, min = 4): number {
  let f = min;
  while (f < n) f *= 2;
  return f;
}
const log2 = (n: number) => Math.round(Math.log2(n));

/** Fisher-Yates mit übergebbarem Zufall */
export function mischen<T>(liste: T[], rnd: () => number): T[] {
  const x = [...liste];
  for (let i = x.length - 1; i > 0; i--) {
    const j = Math.min(i, Math.floor(rnd() * (i + 1)));
    [x[i], x[j]] = [x[j], x[i]];
  }
  return x;
}

/**
 * Vorzugsplätze 1 … N/2 als Linien (0-basiert): Index 0 = Setzplatz 1, 1 = Setzplatz 2, 2–3 = Setzplätze 3/4 (gelost), 4–7 = 5–8 …
 */
export function linienReihenfolge(n: number, rnd: () => number): number[] {
  const k = log2(n);
  const linien = [0];
  for (let stufe = 1; stufe < k; stufe++) {
    const anzahl = 2 ** stufe, groesse = n / anzahl;
    const belegt = new Set(linien.map((l) => Math.floor(l / groesse)));
    const frei = [...Array(anzahl).keys()].filter((s) => !belegt.has(s));
    const obenOben = stufe % 2 === 0 || stufe === 1; // Viertel/Sechzehntel: obere Hälfte oben; Achtel: umgekehrt
    for (const s of mischen(frei, rnd)) {
      const obereHaelfte = s < anzahl / 2;
      const oben = obereHaelfte === obenOben;
      linien.push(oben ? s * groesse : s * groesse + groesse - 1);
    }
  }
  return linien;
}
export const gegenlinie = (l: number) => (l % 2 === 0 ? l + 1 : l - 1);

export interface Kandidat { id: number; setzplatz: number | null }

/**
 * Setzliste: manuell gesetzte (setzplatz) haben Vorrang und behalten möglichst ihren Platz, freie Plätze bekommen die Stärksten.
 * staerke = alle Teilnehmenden in Stärkereihenfolge (nachStaerke). Anzahl = max(gesetzte, manuell Gesetzte), höchstens N/2 und 16.
 */
export function setzlisteBilden(staerke: Kandidat[], gesetzte: number, feld: number): number[] {
  const manuell = staerke.filter((x) => x.setzplatz != null).sort((x, y) => (x.setzplatz as number) - (y.setzplatz as number));
  const anzahl = Math.min(Math.max(gesetzte || 0, manuell.length), feld / 2, 16, staerke.length);
  const plaetze: (number | null)[] = Array(anzahl).fill(null);
  const rest: number[] = [];
  for (const m of manuell) {
    const p = (m.setzplatz as number) - 1;
    if (p < anzahl && plaetze[p] == null) plaetze[p] = m.id; else rest.push(m.id);
  }
  const ohne = staerke.filter((x) => x.setzplatz == null).map((x) => x.id);
  const nachruecken = [...rest, ...ohne];
  for (let i = 0; i < anzahl; i++) if (plaetze[i] == null) plaetze[i] = nachruecken.shift() ?? null;
  return plaetze.filter((x): x is number => x != null);
}

export interface Auslosung {
  feld: number;
  /** Linie → Teilnehmer-ID (null = Freilos) */
  linien: (number | null)[];
  /** Setzliste (Index 0 = Setzplatz 1) */
  gesetzte: number[];
  freilose: number;
}

/** Hauptfeld auslosen: staerke = aktive Teilnehmende in Stärkereihenfolge */
export function auslosen(staerke: Kandidat[], gesetzte: number, rnd: () => number = Math.random): Auslosung {
  const anzahl = staerke.length;
  if (anzahl < 2) throw new Error('Für eine Auslosung braucht es mindestens zwei Teilnehmende.');
  if (anzahl > MAX_FELD) throw new Error(`Das KO-Feld fasst höchstens ${MAX_FELD} Teilnehmende (gemeldet: ${anzahl}).`);
  const feld = zweierpotenz(anzahl);
  const freilose = feld - anzahl;
  const setz = setzlisteBilden(staerke, gesetzte, feld);
  const vorzug = linienReihenfolge(feld, rnd);
  const linien: (number | null)[] = Array(feld).fill(undefined);
  setz.forEach((id, i) => { linien[vorzug[i]] = id; });
  const gesetztSet = new Set(setz);
  let uebrig = staerke.map((x) => x.id).filter((id) => !gesetztSet.has(id));
  // weitere Freilose an die nächststärksten Ungesetzten (Platz unter ihnen gelost)
  if (freilose > setz.length) {
    const plaetze = mischen(vorzug.slice(setz.length, freilose), rnd);
    const starke = uebrig.slice(0, plaetze.length);
    plaetze.forEach((l, i) => { linien[l] = starke[i]; });
    uebrig = uebrig.slice(plaetze.length);
  }
  for (let i = 0; i < freilose; i++) linien[gegenlinie(vorzug[i])] = null;
  const frei = [...linien.keys()].filter((l) => linien[l] === undefined);
  const gelost = mischen(uebrig, rnd);
  frei.forEach((l, i) => { linien[l] = gelost[i]; });
  return { feld, linien, gesetzte: setz, freilose };
}

/** Rundentitel nach Anzahl Spiele */
export function rundenTitel(spiele: number, nr: number): string {
  return spiele === 1 ? 'Finale' : spiele === 2 ? 'Halbfinale' : spiele === 4 ? 'Viertelfinale' : spiele === 8 ? 'Achtelfinale' : `${nr}. Runde`;
}

/** komplette Struktur (Haupt- und Nebenrunde) aus den Linien der 1. Runde */
export function strukturBilden(linien: (number | null)[], nebenrunde: Nebenrunde): Struktur {
  const n = linien.length, k = log2(n);
  const spiele: StrukturSpiel[] = [];
  const runden: StrukturRunde[] = [];
  const h = (runde: number, pos: number): Ort => ({ feld: 'haupt', runde, pos });
  for (let r = 1; r <= k; r++) {
    const m = n / 2 ** r;
    runden.push({ feld: 'haupt', runde: r, titel: rundenTitel(m, r), spiele: m, einstieg: null });
    for (let p = 0; p < m; p++) {
      spiele.push(r === 1
        ? { ...h(1, p), a: { art: 'start', id: linien[2 * p] }, b: { art: 'start', id: linien[2 * p + 1] } }
        : { ...h(r, p), a: { art: 'sieger', von: h(r - 1, 2 * p) }, b: { art: 'sieger', von: h(r - 1, 2 * p + 1) } });
    }
  }
  const neben: { spiele: [Quelle, Quelle][]; einstieg: number | null }[] = [];
  const nb = (runde: number, pos: number): Ort => ({ feld: 'neben', runde, pos });
  const freilosR1 = (p: number) => linien[2 * p] == null || linien[2 * p + 1] == null;
  const letzteRunde = k - 2; // Verlierer bis zu dieser Hauptrunde steigen ein

  if (nebenrunde === 'erste_runde' && letzteRunde >= 1) {
    const plaetze: { q: Quelle; sicher: boolean }[] = [];
    for (let q = 0; q < n / 4; q++) {
      for (const p of [2 * q, 2 * q + 1]) if (!freilosR1(p)) plaetze.push({ q: { art: 'verlierer', von: h(1, p) }, sicher: true });
      if (letzteRunde >= 2 && (freilosR1(2 * q) || freilosR1(2 * q + 1))) {
        const beide = freilosR1(2 * q) && freilosR1(2 * q + 1);
        plaetze.push({ q: { art: 'verlierer', von: h(2, q), nurNachFreilos: !beide }, sicher: beide });
      }
    }
    if (plaetze.length >= 2) {
      const f = zweierpotenz(plaetze.length, 2);
      const vorzug = linienReihenfolge(f, () => 0);
      const frei = f - plaetze.length;
      const lin: (Quelle | undefined)[] = Array(f).fill(undefined);
      for (let i = 0; i < frei; i++) lin[gegenlinie(vorzug[i])] = { art: 'leer' };
      // Linien gegenüber einem Freilos zuerst mit sicheren Plätzen belegen
      const reihe = [...plaetze.filter((x) => x.sicher), ...plaetze.filter((x) => !x.sicher)];
      const gegenFrei = new Set(vorzug.slice(0, frei));
      const genommen = new Set<(typeof plaetze)[number]>();
      for (const l of vorzug.slice(0, frei).sort((x, y) => x - y)) {
        const x = reihe.find((y) => !genommen.has(y));
        if (x) { genommen.add(x); lin[l] = x.q; }
      }
      const restPlaetze = plaetze.filter((x) => !genommen.has(x));
      let i = 0;
      for (let l = 0; l < f; l++) if (lin[l] === undefined && !gegenFrei.has(l)) lin[l] = restPlaetze[i++]?.q ?? { art: 'leer' };
      let runde: [Quelle, Quelle][] = [];
      for (let p = 0; p < f / 2; p++) runde.push([lin[2 * p] as Quelle, lin[2 * p + 1] as Quelle]);
      neben.push({ spiele: runde, einstieg: null });
      while (runde.length > 1) {
        const nr = neben.length;
        runde = [...Array(runde.length / 2).keys()].map((p) => [{ art: 'sieger', von: nb(nr, 2 * p) }, { art: 'sieger', von: nb(nr, 2 * p + 1) }] as [Quelle, Quelle]);
        neben.push({ spiele: runde, einstieg: null });
      }
    }
  } else if (nebenrunde === 'alle' && letzteRunde >= 1) {
    let anz = n / 4;
    neben.push({ spiele: [...Array(anz).keys()].map((p) => [{ art: 'verlierer', von: h(1, 2 * p) }, { art: 'verlierer', von: h(1, 2 * p + 1) }]), einstieg: 1 });
    const paar = () => {
      const nr = neben.length;
      anz /= 2;
      neben.push({ spiele: [...Array(anz).keys()].map((p) => [{ art: 'sieger', von: nb(nr, 2 * p) }, { art: 'sieger', von: nb(nr, 2 * p + 1) }]), einstieg: null });
    };
    for (let r = 2; r <= letzteRunde; r++) {
      const nr = neben.length;
      neben.push({ spiele: [...Array(anz).keys()].map((p) => [{ art: 'sieger', von: nb(nr, p) }, { art: 'verlierer', von: h(r, anz - 1 - p) }]), einstieg: r });
      paar();
    }
    while (anz > 1) paar();
  }
  // Titel der Nebenrunde: nach Spielanzahl, solange kein Einstieg mehr folgt
  neben.forEach((r, i) => {
    const nr = i + 1;
    const spaeterEinstieg = neben.slice(i + 1).some((x) => x.einstieg != null);
    runden.push({ feld: 'neben', runde: nr, titel: spaeterEinstieg ? `${nr}. Runde` : rundenTitel(r.spiele.length, nr), spiele: r.spiele.length, einstieg: r.einstieg });
    r.spiele.forEach(([a, b], p) => spiele.push({ ...nb(nr, p), a, b }));
  });
  return { feld: n, nebenrunde, spiele, runden };
}

/** Spiel wie in der Datenbank (nur, was der Abgleich braucht) */
export interface IstSpiel extends Ort { a: number[]; b: number[]; wertung: Wertung; sieger: Seite | 'x' | null }
export interface Aenderung extends Ort { a: number[]; b: number[]; wertung: 'offen' | 'freilos'; sieger: Seite | null }

type Platz = number | 'leer' | 'offen';
const gleich = (x: number[], y: number[]) => x.length === y.length && x.every((v, i) => v === y[i]);
const alsListe = (p: Platz) => (typeof p === 'number' ? [p] : []);

/**
 * Sollzustand aller Spiele aus Struktur und Ergebnissen. Liefert die nötigen Änderungen (nur ungewertete Spiele, d. h. offen oder
 * Freilos) und Konflikte: gewertete Spiele, deren Paarung sich ändern müsste.
 */
export function abgleichen(s: Struktur, ist: IstSpiel[]): { aenderungen: Aenderung[]; konflikte: Ort[] } {
  const db = new Map(ist.map((x) => [schluessel(x), x]));
  const freilosR1 = new Set<number>();
  for (const x of s.spiele) {
    if (x.feld !== 'haupt' || x.runde !== 1 || x.a.art !== 'start' || x.b.art !== 'start') continue;
    if (x.a.id != null && x.b.id == null) freilosR1.add(x.a.id);
    if (x.b.id != null && x.a.id == null) freilosR1.add(x.b.id);
  }
  const ausgang = new Map<string, { sieger: Platz; verlierer: Platz }>();
  const aenderungen: Aenderung[] = [];
  const konflikte: Ort[] = [];
  const platz = (q: Quelle): Platz => {
    if (q.art === 'start') return q.id ?? 'leer';
    if (q.art === 'leer') return 'leer';
    const e = ausgang.get(schluessel(q.von));
    if (!e) return 'leer';
    if (q.art === 'sieger') return e.sieger;
    if (q.nurNachFreilos && typeof e.verlierer === 'number' && !freilosR1.has(e.verlierer)) return 'leer';
    return e.verlierer;
  };
  // Hauptfeld vor Nebenrunde, Runden aufsteigend – Quellen liegen immer davor
  const reihe = [...s.spiele].sort((x, y) => (x.feld === y.feld ? 0 : x.feld === 'haupt' ? -1 : 1) || x.runde - y.runde || x.pos - y.pos);
  for (const sp of reihe) {
    const a = platz(sp.a), b = platz(sp.b);
    const d = db.get(schluessel(sp));
    const sollA = alsListe(a), sollB = alsListe(b);
    let e: { sieger: Platz; verlierer: Platz };
    let soll: Pick<Aenderung, 'wertung' | 'sieger'> | null; // null = gewertetes Ergebnis bleibt
    if (typeof a === 'number' && typeof b === 'number') {
      if (d && gewertet(d) && gleich(d.a, sollA) && gleich(d.b, sollB) && (d.sieger === 'a' || d.sieger === 'b')) {
        e = d.sieger === 'a' ? { sieger: a, verlierer: b } : { sieger: b, verlierer: a };
        soll = null;
      } else { e = { sieger: 'offen', verlierer: 'offen' }; soll = { wertung: 'offen', sieger: null }; }
    } else if (typeof a === 'number' && b === 'leer') { e = { sieger: a, verlierer: 'leer' }; soll = { wertung: 'freilos', sieger: 'a' }; }
    else if (typeof b === 'number' && a === 'leer') { e = { sieger: b, verlierer: 'leer' }; soll = { wertung: 'freilos', sieger: 'b' }; }
    else if (a === 'leer' && b === 'leer') { e = { sieger: 'leer', verlierer: 'leer' }; soll = { wertung: 'freilos', sieger: null }; }
    else { e = { sieger: 'offen', verlierer: 'offen' }; soll = { wertung: 'offen', sieger: null }; }
    ausgang.set(schluessel(sp), e);
    if (!d) continue;
    if (soll === null) continue;
    if (gewertet(d)) {
      if (!gleich(d.a, sollA) || !gleich(d.b, sollB) || soll.wertung === 'freilos') konflikte.push({ feld: sp.feld, runde: sp.runde, pos: sp.pos });
      continue;
    }
    if (!gleich(d.a, sollA) || !gleich(d.b, sollB) || d.wertung !== soll.wertung || (d.sieger ?? null) !== soll.sieger) {
      aenderungen.push({ feld: sp.feld, runde: sp.runde, pos: sp.pos, a: sollA, b: sollB, ...soll });
    }
  }
  return { aenderungen, konflikte };
}

/** Linien der 1. Hauptrunde aus den gespeicherten Spielen */
export function linienAusSpielen(ist: Pick<IstSpiel, 'feld' | 'runde' | 'pos' | 'a' | 'b'>[]): (number | null)[] {
  const r1 = ist.filter((x) => x.feld === 'haupt' && x.runde === 1).sort((x, y) => x.pos - y.pos);
  return r1.flatMap((x) => [x.a[0] ?? null, x.b[0] ?? null]);
}

// ------------------------------------------------------------------ Live-Daten (für die Oberfläche)
export interface KoLiveSpiel {
  id: number;
  runde: number;
  pos: number;
  a: number | null;
  b: number | null;
  saetze: Satz[] | null;
  wertung: Wertung;
  sieger: Seite | 'x' | null;
}
export interface KoLiveRunde { nr: number; titel: string; einstieg: number | null; spiele: KoLiveSpiel[] }
export interface KoLiveFeld { runden: KoLiveRunde[]; sieger: number | null }
export interface KoLiveDaten {
  ausgelost: boolean;
  feld: number | null;
  nebenrunde: Nebenrunde;
  haupt: KoLiveFeld | null;
  neben: KoLiveFeld | null;
  /** Teilnehmer-ID → Setzplatz */
  gesetzte: Record<number, number>;
}
/** In den Einstellungen gespeicherter Stand der Auslosung */
export interface KoAuslosungInfo { feld: number; nebenrunde: Nebenrunde; gesetzte: Record<string, number>; am: string }
