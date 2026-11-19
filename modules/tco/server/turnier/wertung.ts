/**
 * Turniere: Ergebnisse prüfen und auswerten – ohne Datenbank, auch von der Oberfläche nutzbar.
 *
 * Zählweise Einzel (KO, Liga): 2 Gewinnsätze, dritter Satz als Match-Tiebreak bis 10 (2 Punkte Abstand).
 * Ein Satz endet 6:0 … 6:4, 7:5 oder 7:6. Der Match-Tiebreak zählt in der Spielstatistik als 1:0.
 * Kampflos (w.o.) zählt für den Sieger als 6:0 6:0. Spaßturnier: ein „Satz“ = Spiele je Team nach Ablauf der Zeit,
 * Unentschieden möglich.
 */
import type { Satz, Seite, Spiel, Wertung } from './typen.js';

export class ErgebnisFehler extends Error {}

export interface Auswertung {
  sieger: Seite | 'x' | null;
  /** gewonnene Sätze je Seite */
  saetze: [number, number];
  /** gewonnene Spiele je Seite (Match-Tiebreak = 1:0) */
  spiele: [number, number];
}

const ganz = (n: unknown) => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 99;

/** regulärer Satz fertig gespielt? → Gewinner, sonst null */
export function satzSieger([x, y]: Satz): Seite | null {
  const hi = Math.max(x, y), lo = Math.min(x, y);
  const fertig = (hi === 6 && lo <= 4) || (hi === 7 && (lo === 5 || lo === 6));
  return fertig ? (x > y ? 'a' : 'b') : null;
}

/** Match-Tiebreak fertig? (bis 10, 2 Punkte Abstand) */
export function tiebreakSieger([x, y]: Satz): Seite | null {
  const hi = Math.max(x, y), lo = Math.min(x, y);
  const fertig = hi >= 10 && hi - lo >= 2 && (hi === 10 || hi - lo === 2);
  return fertig ? (x > y ? 'a' : 'b') : null;
}

/**
 * Tennis-Ergebnis (2 Gewinnsätze, MTB) prüfen und auswerten.
 * wertung 'gespielt': vollständiges Ergebnis Pflicht. 'aufgabe': Sätze bis zur Aufgabe, sieger Pflicht (wer gewinnt).
 * 'wo': sieger Pflicht, Sätze werden ignoriert (zählt 6:0 6:0). 'keine': niemand bekommt etwas.
 */
export function einzelAuswerten(wertung: Wertung, saetze: Satz[] | null | undefined, sieger?: Seite | null): Auswertung {
  if (wertung === 'offen' || wertung === 'freilos') return { sieger: wertung === 'freilos' ? (sieger ?? null) : null, saetze: [0, 0], spiele: [0, 0] };
  if (wertung === 'keine') return { sieger: null, saetze: [0, 0], spiele: [0, 0] };
  if (wertung === 'wo') {
    if (sieger !== 'a' && sieger !== 'b') throw new ErgebnisFehler('Bei „kampflos“ bitte angeben, wer gewinnt.');
    return { sieger, saetze: sieger === 'a' ? [2, 0] : [0, 2], spiele: sieger === 'a' ? [12, 0] : [0, 12] };
  }
  const s = saetze ?? [];
  if (s.length > 3) throw new ErgebnisFehler('Höchstens drei Sätze (dritter Satz als Match-Tiebreak).');
  for (const x of s) if (!Array.isArray(x) || x.length !== 2 || !ganz(x[0]) || !ganz(x[1])) throw new ErgebnisFehler('Bitte nur ganze Zahlen je Satz eingeben.');
  const gew: [number, number] = [0, 0];
  const spiele: [number, number] = [0, 0];
  for (let i = 0; i < s.length; i++) {
    const istMtb = i === 2;
    const w = istMtb ? tiebreakSieger(s[i]) : satzSieger(s[i]);
    const letzter = i === s.length - 1;
    if (!w) {
      if (wertung === 'aufgabe' && letzter) { // abgebrochener Satz: Spiele zählen, Satz nicht
        if (!istMtb) { spiele[0] += s[i][0]; spiele[1] += s[i][1]; }
        continue;
      }
      throw new ErgebnisFehler(istMtb
        ? `Match-Tiebreak ${s[i][0]}:${s[i][1]} ist kein gültiges Ergebnis (bis 10, 2 Punkte Abstand).`
        : `Satz ${i + 1} ${s[i][0]}:${s[i][1]} ist kein gültiges Ergebnis (6:0 bis 6:4, 7:5 oder 7:6).`);
    }
    if (gew[0] === 2 || gew[1] === 2) throw new ErgebnisFehler('Das Match war nach zwei gewonnenen Sätzen schon entschieden.');
    gew[w === 'a' ? 0 : 1]++;
    if (istMtb) spiele[w === 'a' ? 0 : 1]++;
    else { spiele[0] += s[i][0]; spiele[1] += s[i][1]; }
  }
  if (wertung === 'gespielt') {
    if (gew[0] < 2 && gew[1] < 2) throw new ErgebnisFehler(s.length === 2 ? 'Bei 1:1 Sätzen bitte den Match-Tiebreak eintragen.' : 'Das Ergebnis ist noch nicht vollständig (2 Gewinnsätze).');
    return { sieger: gew[0] === 2 ? 'a' : 'b', saetze: gew, spiele };
  }
  // Aufgabe
  if (sieger !== 'a' && sieger !== 'b') throw new ErgebnisFehler('Bei „Aufgabe“ bitte angeben, wer gewinnt.');
  if (gew[0] === 2 || gew[1] === 2) throw new ErgebnisFehler('Das Match ist bereits entschieden – bitte „gespielt“ wählen.');
  return { sieger, saetze: gew, spiele };
}

/** Spaßturnier: Spiele je Team nach Ablauf der Rundenzeit; Unentschieden = 'x' */
export function spassAuswerten(spieleA: number, spieleB: number): Auswertung {
  if (!ganz(spieleA) || !ganz(spieleB)) throw new ErgebnisFehler('Bitte die gewonnenen Spiele je Team als ganze Zahl eingeben.');
  return { sieger: spieleA > spieleB ? 'a' : spieleB > spieleA ? 'b' : 'x', saetze: [0, 0], spiele: [spieleA, spieleB] };
}

/** Bilanz einer Person über beliebig viele Spiele (Einzel und Doppel) */
export interface Bilanz {
  teilnehmer_id: number;
  spiele: number;
  siege: number;
  niederlagen: number;
  unentschieden: number;
  saetze: [number, number];
  spielstand: [number, number];
  /** Siegquote 0…1: (Siege + ½ Unentschieden) / gewertete Spiele; 0 ohne Spiele */
  quote: number;
}

export const leereBilanz = (id: number): Bilanz => ({ teilnehmer_id: id, spiele: 0, siege: 0, niederlagen: 0, unentschieden: 0, saetze: [0, 0], spielstand: [0, 0], quote: 0 });

/** gewertet = es gibt ein Ergebnis für mindestens eine Seite (offen, Freilos und „keine Wertung“ zählen nicht) */
export const gewertet = (s: Pick<Spiel, 'wertung'>) => s.wertung === 'gespielt' || s.wertung === 'aufgabe' || s.wertung === 'wo';

/**
 * Bilanzen aus den Spielen. Spiele mit Satzergebnis (Einzel) werden über einzelAuswerten gezählt, Spiele im Feld
 * 'runde' (Spaßturnier) über spassAuswerten. Ungewertete Spiele werden übersprungen.
 */
export function bilanzen(spiele: Pick<Spiel, 'feld' | 'a' | 'b' | 'saetze' | 'wertung' | 'sieger'>[], ids?: number[]): Map<number, Bilanz> {
  const m = new Map<number, Bilanz>();
  const b = (id: number) => { let x = m.get(id); if (!x) { x = leereBilanz(id); m.set(id, x); } return x; };
  for (const id of ids ?? []) b(id);
  for (const s of spiele) {
    if (!gewertet(s)) continue;
    const e = s.feld === 'runde'
      ? spassAuswerten(s.saetze?.[0]?.[0] ?? 0, s.saetze?.[0]?.[1] ?? 0)
      : einzelAuswerten(s.wertung, s.saetze, s.sieger === 'x' ? null : s.sieger);
    for (const [seite, idx] of [['a', 0], ['b', 1]] as const) {
      const gegen = 1 - idx;
      for (const id of s[seite]) {
        const x = b(id);
        x.spiele++;
        if (e.sieger === 'x') x.unentschieden++;
        else if (e.sieger === seite) x.siege++;
        else x.niederlagen++;
        x.saetze[0] += e.saetze[idx]; x.saetze[1] += e.saetze[gegen];
        x.spielstand[0] += e.spiele[idx]; x.spielstand[1] += e.spiele[gegen];
      }
    }
  }
  for (const x of m.values()) x.quote = x.spiele ? (x.siege + x.unentschieden / 2) / x.spiele : 0;
  return m;
}

/** Ergebnis als Text „6:4 3:6 10:8“, „w.o.“, „Aufg.“ */
export function ergebnisText(s: Pick<Spiel, 'saetze' | 'wertung' | 'sieger'>, aus: Seite = 'a'): string {
  if (s.wertung === 'wo') return 'w.o.';
  if (s.wertung === 'keine') return 'nicht gespielt';
  if (s.wertung === 'freilos') return 'Freilos';
  if (!s.saetze?.length) return '';
  const t = s.saetze.map(([x, y]) => (aus === 'a' ? `${x}:${y}` : `${y}:${x}`)).join(' ');
  return s.wertung === 'aufgabe' ? `${t} Aufg.` : t;
}
