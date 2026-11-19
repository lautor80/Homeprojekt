/**
 * Spaßturnier (Doppel/Mixed): reine Logik ohne Datenbank – Auslosung einer Runde und Rangliste.
 *
 * Auslosung:
 *  - Spielende = min(4 · Plätze, größtes Vielfaches von 4 ≤ Verfügbare); verfügbar ist, wer keine Pause wünscht.
 *  - Erzwungene Pausen bekommen zuerst die, die am meisten gespielt bzw. am wenigsten pausiert haben
 *    (Ziel: alle spielen gleich oft), bei Gleichstand entscheidet der Zufall.
 *  - Paarungen: Kosten minimieren – wiederholter Partner sehr teuer, wiederholter Gegner teuer (je Wiederholung steigend).
 *    Viele Zufallsstarts mit lokaler Tauschverbesserung; für 64 Personen / 16 Plätze deutlich unter 300 ms.
 */
import { bilanzen, type Bilanz } from './wertung.js';
import type { Runde, Spiel, SpassEinstellungen, Turnier } from './typen.js';

export type Zufall = () => number;

/** bisheriger Verlauf: Paarungen (alle ausgelosten Spiele, auch ungewertete) und Pausen je Person */
export interface Historie {
  /** Schlüssel „kleinere-größere“ ID → Anzahl gemeinsamer Spiele als Partner */
  partner: Map<string, number>;
  /** Schlüssel „kleinere-größere“ ID → Anzahl Spiele gegeneinander */
  gegner: Map<string, number>;
  /** Runden mit Spiel je Person */
  gespielt: Map<number, number>;
  /** Runden mit Pause je Person (gewünscht oder zugelost) */
  pausen: Map<number, number>;
}

export const paarSchluessel = (x: number, y: number) => (x < y ? `${x}-${y}` : `${y}-${x}`);
const plus = <K>(m: Map<K, number>, k: K, n = 1) => m.set(k, (m.get(k) ?? 0) + n);

/** Historie aus den Spielen (a/b je zwei IDs) und den Pausen (je Runde die pausierenden IDs) */
export function historieAus(spiele: Pick<Spiel, 'a' | 'b'>[], pausen: number[]): Historie {
  const h: Historie = { partner: new Map(), gegner: new Map(), gespielt: new Map(), pausen: new Map() };
  for (const s of spiele) {
    for (const team of [s.a, s.b]) {
      for (const id of team) plus(h.gespielt, id);
      if (team.length === 2) plus(h.partner, paarSchluessel(team[0], team[1]));
    }
    for (const x of s.a) for (const y of s.b) plus(h.gegner, paarSchluessel(x, y));
  }
  for (const id of pausen) plus(h.pausen, id);
  return h;
}

export interface AuslosungEingabe {
  /** aktive (gemeldete) Personen */
  personen: number[];
  /** wer in dieser Runde bewusst pausieren möchte */
  pauseWunsch: number[];
  historie: Historie;
  plaetze: number;
  rnd: Zufall;
  /** Zufallsstarts der Paarungssuche (Standard 40) */
  starts?: number;
}
export interface AuslosungSpiel { platz: number; a: [number, number]; b: [number, number] }
export interface Auslosung {
  spiele: AuslosungSpiel[];
  /** alle Pausierenden dieser Runde (gewünscht und zugelost) */
  pause: number[];
  /** davon gewünscht */
  pauseGewuenscht: number[];
  /** Kosten der Paarung (0 = keine Wiederholung) */
  kosten: number;
}

/** Kosten: Partner je Wiederholung steigend sehr teuer, Gegner steigend teuer */
export const PARTNER_KOSTEN = (n: number) => 1000 * n * n;
export const GEGNER_KOSTEN = (n: number) => 10 * n * n;

function mischen<T>(l: T[], rnd: Zufall): T[] {
  for (let i = l.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [l[i], l[j]] = [l[j], l[i]];
  }
  return l;
}

/** Wer pausiert? Wünsche zuerst, dann die mit den meisten gespielten Runden / wenigsten Pausen (Gleichstand: Zufall) */
export function pausenWaehlen(e: Pick<AuslosungEingabe, 'personen' | 'pauseWunsch' | 'historie' | 'plaetze' | 'rnd'>) {
  const wunsch = new Set(e.pauseWunsch.filter((id) => e.personen.includes(id)));
  const verfuegbar = e.personen.filter((id) => !wunsch.has(id));
  const anzahl = Math.max(0, Math.min(4 * Math.max(0, Math.floor(e.plaetze)), Math.floor(verfuegbar.length / 4) * 4));
  const zufall = new Map(verfuegbar.map((id) => [id, e.rnd()]));
  const g = (id: number) => e.historie.gespielt.get(id) ?? 0;
  const p = (id: number) => e.historie.pausen.get(id) ?? 0;
  // zuerst pausieren: meiste Spiele, dann wenigste Pausen, dann Zufall
  const reihe = [...verfuegbar].sort((x, y) => g(y) - g(x) || p(x) - p(y) || zufall.get(x)! - zufall.get(y)!);
  const zwang = reihe.slice(0, verfuegbar.length - anzahl);
  const spielen = reihe.slice(verfuegbar.length - anzahl);
  return { spielen, pause: [...wunsch, ...zwang], pauseGewuenscht: [...wunsch] };
}

/**
 * Paarungen für genau 4·k Spielende. Reihenfolge p: Spiel m = (p[4m], p[4m+1]) gegen (p[4m+2], p[4m+3]).
 * Kosten über Matrizen (lokale Indizes), lokale Suche: jedes Positionspaar tauschen, solange es besser wird.
 */
export function paarungenSuchen(spielen: number[], h: Pick<Historie, 'partner' | 'gegner'>, rnd: Zufall, starts = 40): { spiele: [number, number, number, number][]; kosten: number } {
  const n = spielen.length;
  if (n % 4) throw new Error('Anzahl Spielende muss durch 4 teilbar sein.');
  if (!n) return { spiele: [], kosten: 0 };
  const pk = new Float64Array(n * n), gk = new Float64Array(n * n);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    if (i === j) continue;
    const k = paarSchluessel(spielen[i], spielen[j]);
    pk[i * n + j] = PARTNER_KOSTEN(h.partner.get(k) ?? 0);
    gk[i * n + j] = GEGNER_KOSTEN(h.gegner.get(k) ?? 0);
  }
  const spielKosten = (p: Int32Array, m: number) => {
    const a = p[4 * m], b = p[4 * m + 1], c = p[4 * m + 2], d = p[4 * m + 3];
    return pk[a * n + b] + pk[c * n + d] + gk[a * n + c] + gk[a * n + d] + gk[b * n + c] + gk[b * n + d];
  };
  const spieleAnz = n / 4;
  let beste: Int32Array | null = null;
  let besteKosten = Infinity;
  const p = new Int32Array(n);
  const sk = new Float64Array(spieleAnz);
  for (let s = 0; s < starts && besteKosten > 0; s++) {
    const reihe = mischen([...Array(n).keys()], rnd);
    for (let i = 0; i < n; i++) p[i] = reihe[i];
    let summe = 0;
    for (let m = 0; m < spieleAnz; m++) { sk[m] = spielKosten(p, m); summe += sk[m]; }
    let besser = true;
    while (besser && summe > 0) {
      besser = false;
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const mi = i >> 2, mj = j >> 2;
          // Tausch innerhalb eines Teams oder zwischen „gleichwertigen“ Positionen ändert nichts
          if (mi === mj && ((i ^ j) === 1)) continue;
          const t = p[i]; p[i] = p[j]; p[j] = t;
          const ki = spielKosten(p, mi);
          const kj = mi === mj ? 0 : spielKosten(p, mj);
          const alt = mi === mj ? sk[mi] : sk[mi] + sk[mj];
          const neu = ki + kj;
          if (neu < alt - 1e-9) {
            sk[mi] = ki; if (mi !== mj) sk[mj] = kj;
            summe += neu - alt;
            besser = true;
          } else { p[j] = p[i]; p[i] = t; }
        }
      }
    }
    if (summe < besteKosten) { besteKosten = summe; beste = Int32Array.from(p); }
  }
  const b = beste!;
  const spiele: [number, number, number, number][] = [];
  for (let m = 0; m < spieleAnz; m++) spiele.push([spielen[b[4 * m]], spielen[b[4 * m + 1]], spielen[b[4 * m + 2]], spielen[b[4 * m + 3]]]);
  return { spiele, kosten: Math.round(besteKosten) };
}

/** eine Runde auslosen: Pausen wählen, Paarungen suchen, Plätze 1…n zuordnen */
export function rundeAuslosen(e: AuslosungEingabe): Auslosung {
  const { spielen, pause, pauseGewuenscht } = pausenWaehlen(e);
  const { spiele, kosten } = paarungenSuchen(spielen, e.historie, e.rnd, e.starts ?? 40);
  return {
    spiele: spiele.map((s, i) => ({ platz: i + 1, a: [s[0], s[1]], b: [s[2], s[3]] })),
    pause, pauseGewuenscht, kosten,
  };
}

export interface RanglistenZeile extends Bilanz {
  /** Platz in der Rangliste (gleicher Platz bei völligem Gleichstand) */
  rang: number;
  /** Spieldifferenz (gewonnene − verlorene Spiele) */
  differenz: number;
  /** Runden mit Spiel (ausgelost) */
  runden: number;
  pausen: number;
}

/**
 * Rangliste: nach Siegquote, dann Siegen, dann Spieldifferenz (Unentschieden zählt halb).
 * runden/pausen: Anzahl ausgeloster Runden mit Spiel bzw. Pause je Person.
 */
export function rangliste(spiele: Pick<Spiel, 'feld' | 'a' | 'b' | 'saetze' | 'wertung' | 'sieger'>[], ids: number[],
  zaehler: { gespielt: Map<number, number>; pausen: Map<number, number> }): RanglistenZeile[] {
  const b = bilanzen(spiele.filter((s) => s.feld === 'runde'), ids);
  const zeilen = [...b.values()].map((x) => ({
    ...x, rang: 0, differenz: x.spielstand[0] - x.spielstand[1],
    runden: zaehler.gespielt.get(x.teilnehmer_id) ?? 0, pausen: zaehler.pausen.get(x.teilnehmer_id) ?? 0,
  }));
  const vgl = (x: RanglistenZeile, y: RanglistenZeile) => y.quote - x.quote || y.siege - x.siege || y.differenz - x.differenz;
  zeilen.sort((x, y) => vgl(x, y) || y.spiele - x.spiele || x.teilnehmer_id - y.teilnehmer_id);
  zeilen.forEach((z, i) => { z.rang = i > 0 && vgl(zeilen[i - 1], z) === 0 ? zeilen[i - 1].rang : i + 1; });
  return zeilen;
}

/** deterministischer Zufall für Tests (mulberry32) */
export function zufallMitStart(seed: number): Zufall {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------------ Antworttypen (auch für die Oberfläche)

/** Platz einer Runde (ein Doppel) */
export interface SpassPlatzDaten {
  spiel_id: number;
  platz: number;
  a: number[];
  b: number[];
  saetze: [number, number][] | null;
  wertung: Spiel['wertung'];
  sieger: Spiel['sieger'];
}
export interface SpassRundeDaten {
  id: number;
  nr: number;
  status: Runde['status'];
  beginn: string | null;
  minuten: number;
  /** Ende der Spielzeit (ISO), null solange nicht gestartet */
  endeUm: string | null;
  plaetze: SpassPlatzDaten[];
  /** Teilnehmer-IDs mit Pause in dieser Runde (gewünscht oder zugelost) */
  pausen: number[];
  pausen_gewuenscht: number[];
}
/** Live-Daten des Spaßturniers (daten in GET …/live) */
export interface SpassLiveDaten {
  einstellungen: SpassEinstellungen;
  /** aktuelle (letzte) Runde, null = noch keine ausgelost */
  runde: SpassRundeDaten | null;
  runden: { nr: number; status: Runde['status']; beginn: string | null; minuten: number; spiele: number; gewertet: number }[];
  rangliste: RanglistenZeile[];
  /** Pausenwünsche für die nächste Runde */
  pause_naechste: number[];
  /** true, wenn die eingestellte Rundenzahl erreicht ist */
  fertig: boolean;
}

/** GET /turnier/spass/platz/:kennung – aktuelle Runde für die Eingabe am Platz (Kurznamen) */
export interface SpassPlatzAntwort {
  turnier: Pick<Turnier, 'name' | 'kennung' | 'status'>;
  runde: (Omit<SpassRundeDaten, 'id' | 'plaetze' | 'pausen' | 'pausen_gewuenscht'> & {
    plaetze: (SpassPlatzDaten & { namen_a: string[]; namen_b: string[] })[];
    pausen: string[];
  }) | null;
  stand: string;
}

/** GET /turnier/spass/zugang/:schluessel – persönlicher Link */
export interface SpassZugangAntwort {
  pause_naechste: boolean;
  fertig: boolean;
  runde: (Pick<SpassRundeDaten, 'nr' | 'status' | 'beginn' | 'minuten' | 'endeUm'> & { pause: boolean }) | null;
  platz: { spiel_id: number; platz: number; seite: 'a' | 'b'; partner: string[]; gegner: string[]; saetze: [number, number][] | null; wertung: Spiel['wertung'] } | null;
  rang: RanglistenZeile | null;
}
