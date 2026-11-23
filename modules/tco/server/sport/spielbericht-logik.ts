/**
 * Spielbericht (Sport → Spielberichte): Mannschaftsspieltag nach dem DTB-Spielbericht prüfen und auswerten – ohne
 * Datenbank, wird auch von der Oberfläche importiert (gleiche Prüfung beim Tippen und beim Einreichen).
 *
 * Zählweise: 2 Gewinnsätze, dritter Satz als Match-Tiebreak bis 10 (zählt als 1:0 Spiele). Satzprüfung wie bei den
 * Turnieren (`turnier/wertung.ts`, hier ohne Import nachgebildet). Kampflos zählt 6:0 6:0. Bei Aufgabe bekommt der Gegner die zum Sieg fehlenden
 * Spiele und Sätze gutgeschrieben (laufender Satz wird zu Ende gezählt, fehlende Sätze 6:0, bei 1:1 Match-Tiebreak 1:0).
 *
 * Aufstellung: Einzel in der Reihenfolge der Meldeliste (Rang aufsteigend), kein Spieler doppelt; Doppel aus zwei
 * verschiedenen Spielern, jeder Spieler höchstens in einem Doppel, Positionssumme von Doppel 1 an gleichbleibend oder
 * steigend. Sieger: Match-Punkte, dann Sätze, dann Spiele.
 */

// Satzprüfung wie in turnier/wertung.ts (satzSieger, tiebreakSieger) – hier ohne Import, damit die Oberfläche die Datei
// ohne weitere Abhängigkeiten laden kann; server/test/tco_spielbericht_logik.test.ts prüft die Gleichheit.
export function satzSieger([x, y]: [number, number]): 'a' | 'b' | null {
  const hi = Math.max(x, y), lo = Math.min(x, y);
  return (hi === 6 && lo <= 4) || (hi === 7 && (lo === 5 || lo === 6)) ? (x > y ? 'a' : 'b') : null;
}
export function tiebreakSieger([x, y]: [number, number]): 'a' | 'b' | null {
  const hi = Math.max(x, y), lo = Math.min(x, y);
  return hi >= 10 && hi - lo >= 2 && (hi === 10 || hi - lo === 2) ? (x > y ? 'a' : 'b') : null;
}

export type SbFormat = '6er' | '4er';
export const FORMATE: Record<SbFormat, { einzel: number; doppel: number; text: string }> = {
  '6er': { einzel: 6, doppel: 3, text: '6 Einzel, 3 Doppel' },
  '4er': { einzel: 4, doppel: 2, text: '4 Einzel, 2 Doppel' },
};

/** Spieler im Bericht: Stand aus der Meldeliste zum Zeitpunkt der Aufstellung (ändert sich nicht mit der Liste) */
export interface SbSpieler { rang: number | null; name: string; id_nr: string | null; mannschaft?: number | null }
export type SbWertung = 'gespielt' | 'aufgabe' | 'wo';
export type SbSeite = 'a' | 'b';
/** a = Heim (Mannschaft A), b = Gast (Mannschaft B); Einzel: je ein Spieler, Doppel: je zwei */
export interface SbMatch {
  a: (SbSpieler | null)[];
  b: (SbSpieler | null)[];
  /** drei Sätze [Heim, Gast]; der dritte ist der Match-Tiebreak; null = nicht eingetragen */
  saetze: [number | null, number | null][];
  wertung: SbWertung;
  /** bei Aufgabe und kampflos: wer gewinnt */
  sieger: SbSeite | null;
}
export interface SbDaten {
  format: SbFormat;
  osr: string;
  zuschauer: number | null;
  /** HH:MM */
  beginn: string;
  ende: string;
  bemerkungen: string;
  einzel: SbMatch[];
  doppel: SbMatch[];
}

export const leeresMatch = (doppel: boolean): SbMatch => ({
  a: doppel ? [null, null] : [null], b: doppel ? [null, null] : [null], saetze: [[null, null], [null, null], [null, null]], wertung: 'gespielt', sieger: null,
});
export function leererBericht(format: SbFormat = '6er'): SbDaten {
  const f = FORMATE[format];
  return {
    format, osr: '', zuschauer: null, beginn: '', ende: '', bemerkungen: '',
    einzel: Array.from({ length: f.einzel }, () => leeresMatch(false)), doppel: Array.from({ length: f.doppel }, () => leeresMatch(true)),
  };
}
/** Anzahl der Einzel und Doppel an das Format anpassen (vorhandene Einträge bleiben, überzählige fallen weg) */
export function formatAnpassen(d: SbDaten, format: SbFormat): SbDaten {
  const f = FORMATE[format];
  const fuellen = (l: SbMatch[], n: number, doppel: boolean) => [...l.slice(0, n), ...Array.from({ length: Math.max(0, n - l.length) }, () => leeresMatch(doppel))];
  return { ...d, format, einzel: fuellen(d.einzel, f.einzel, false), doppel: fuellen(d.doppel, f.doppel, true) };
}

export type MatchStatus = 'offen' | 'laeuft' | 'fertig' | 'fehler';
export interface MatchErgebnis {
  status: MatchStatus;
  sieger: SbSeite | null;
  saetze: [number, number];
  spiele: [number, number];
  /** je Satz: Eingabe ungültig */
  satzFehler: [boolean, boolean, boolean];
  fehler: string | null;
  /** Match-Tiebreak wird gebraucht (1:1 Sätze) */
  mtbNoetig: boolean;
}

const gesetzt = (s: [number | null, number | null]) => s[0] != null || s[1] != null;
const voll = (s: [number | null, number | null]): s is [number, number] => s[0] != null && s[1] != null;

/** laufenden Satz für den Sieger zu Ende zählen (Aufgabe): 6 Spiele bzw. 7:5 / 7:6 */
function satzZuEnde(gew: number, verl: number): [number, number] {
  if (verl <= 4) return [Math.max(6, gew), verl];
  return [7, verl];
}

export function matchWerten(m: SbMatch): MatchErgebnis {
  const r: MatchErgebnis = { status: 'offen', sieger: null, saetze: [0, 0], spiele: [0, 0], satzFehler: [false, false, false], fehler: null, mtbNoetig: false };
  const fehler = (j: number, text: string) => { r.satzFehler[j] = true; r.fehler ??= text; r.status = 'fehler'; };
  const s = [0, 1, 2].map((j) => m.saetze[j] ?? [null, null]) as [number | null, number | null][];

  if (m.wertung === 'wo') {
    if (!m.sieger) return { ...r, status: 'laeuft', fehler: 'Bei „kampflos“ bitte angeben, wer gewinnt.' };
    return { ...r, status: 'fertig', sieger: m.sieger, saetze: m.sieger === 'a' ? [2, 0] : [0, 2], spiele: m.sieger === 'a' ? [12, 0] : [0, 12] };
  }
  if (s.some(gesetzt)) r.status = 'laeuft';
  const gew: [number, number] = [0, 0];
  // reguläre Sätze
  // bei Aufgabe darf der zuletzt eingetragene Satz unvollständig sein (dort wurde abgebrochen)
  const letzter = s.reduce((n, x, j) => (gesetzt(x) ? j : n), -1);
  let offenerSatz = -1;
  for (let j = 0; j < 2; j++) {
    if (!gesetzt(s[j])) continue;
    const w = voll(s[j]) ? satzSieger(s[j] as [number, number]) : null;
    if (!w) {
      if (m.wertung === 'aufgabe' && j === letzter) { offenerSatz = j; continue; }
      if (!voll(s[j])) { offenerSatz = j; continue; }
      fehler(j, `Satz ${j + 1} ${s[j][0]}:${s[j][1]} ist kein gültiges Ergebnis (6:0 bis 6:4, 7:5 oder 7:6).`);
      continue;
    }
    gew[w === 'a' ? 0 : 1]++;
    r.spiele[0] += s[j][0]!; r.spiele[1] += s[j][1]!;
  }
  r.mtbNoetig = gew[0] === 1 && gew[1] === 1;
  if (gesetzt(s[2])) {
    if (!r.mtbNoetig) fehler(2, gew[0] + gew[1] === 2 ? 'Match-Tiebreak nur bei 1:1 Sätzen.' : 'Match-Tiebreak erst nach zwei Sätzen.');
    else {
      const w = voll(s[2]) ? tiebreakSieger(s[2] as [number, number]) : null;
      if (w) { gew[w === 'a' ? 0 : 1]++; r.spiele[w === 'a' ? 0 : 1]++; }
      else if (m.wertung === 'aufgabe' || !voll(s[2])) offenerSatz = 2;
      else fehler(2, `Match-Tiebreak ${s[2][0]}:${s[2][1]} ist kein gültiges Ergebnis (bis 10, 2 Punkte Abstand).`);
    }
  }
  if (r.status === 'fehler') return { ...r, saetze: gew };

  if (m.wertung === 'gespielt') {
    r.saetze = gew;
    if (gew[0] === 2 || gew[1] === 2) { r.status = 'fertig'; r.sieger = gew[0] === 2 ? 'a' : 'b'; }
    return r;
  }

  // Aufgabe: dem Sieger die fehlenden Spiele und Sätze gutschreiben
  if (!m.sieger) return { ...r, saetze: gew, status: 'laeuft', fehler: 'Bei „Aufgabe“ bitte angeben, wer gewinnt.' };
  const si = m.sieger === 'a' ? 0 : 1, ve = 1 - si;
  if (gew[ve] === 2) return { ...r, saetze: gew, status: 'fehler', fehler: 'Das Match war schon entschieden – bitte „gespielt“ wählen.' };
  if (offenerSatz >= 0) {
    const x = s[offenerSatz];
    const g = Number(x[si] ?? 0), v = Number(x[ve] ?? 0);
    if (offenerSatz === 2) { gew[si]++; r.spiele[si]++; }
    else {
      const [eg, ev] = satzZuEnde(g, v);
      r.spiele[si] += eg; r.spiele[ve] += ev; gew[si]++;
    }
  }
  while (gew[si] < 2) {
    if (gew[si] === 1 && gew[ve] === 1) { gew[si]++; r.spiele[si]++; }   // Match-Tiebreak
    else { gew[si]++; r.spiele[si] += 6; }
  }
  return { ...r, saetze: gew, status: 'fertig', sieger: m.sieger };
}

export interface Summe { punkte: [number, number]; saetze: [number, number]; spiele: [number, number] }
const nullSumme = (): Summe => ({ punkte: [0, 0], saetze: [0, 0], spiele: [0, 0] });
function addieren(t: Summe, e: MatchErgebnis) {
  if (e.status === 'fertig' && e.sieger) t.punkte[e.sieger === 'a' ? 0 : 1]++;
  if (e.status !== 'fehler') for (const i of [0, 1]) { t.saetze[i] += e.saetze[i]; t.spiele[i] += e.spiele[i]; }
}

export interface Pruefung { id: string; ok: boolean; text: string }
export interface BerichtAuswertung {
  einzel: MatchErgebnis[];
  doppel: MatchErgebnis[];
  summe: Summe;
  summeEinzel: Summe;
  summeDoppel: Summe;
  fertig: number;
  anzahl: number;
  /** Sieger nach Match-Punkten, Sätzen, Spielen; 'x' = unentschieden; null = noch offen */
  sieger: SbSeite | 'x' | null;
  /** Sieger steht fest, auch wenn noch Spiele offen sind (Mehrheit der Match-Punkte) */
  entschieden: boolean;
  pruefungen: Pruefung[];
  /** Warnungen je Abschnitt (Aufstellung) */
  hinweiseEinzel: string[];
  hinweiseDoppel: string[];
  /** alle Prüfungen erfüllt */
  vollstaendig: boolean;
}

const schluessel = (p: SbSpieler) => (p.id_nr ? `id:${p.id_nr}` : `n:${p.name.trim().toLowerCase()}`);
const SEITE = { a: 'Heim', b: 'Gast' } as const;

/** mannschaft: Nummer der Mannschaft je Seite (1 = erste), für den Hinweis auf Spieler höherer Mannschaften */
export function berichtWerten(d: SbDaten, mannschaft: { a?: number | null; b?: number | null } = {}): BerichtAuswertung {
  const einzel = d.einzel.map(matchWerten), doppel = d.doppel.map(matchWerten);
  const summe = nullSumme(), summeEinzel = nullSumme(), summeDoppel = nullSumme();
  einzel.forEach((e) => { addieren(summe, e); addieren(summeEinzel, e); });
  doppel.forEach((e) => { addieren(summe, e); addieren(summeDoppel, e); });
  const alle = [...einzel, ...doppel];
  const fertig = alle.filter((e) => e.status === 'fertig').length, anzahl = alle.length;
  const hinweiseEinzel: string[] = [], hinweiseDoppel: string[] = [];

  // Einzel-Aufstellung
  const einzelVoll = d.einzel.every((m) => m.a[0] && m.b[0]);
  let einzelDoppelt = false, einzelReihe = true;
  for (const s of ['a', 'b'] as const) {
    const spieler = d.einzel.map((m) => m[s][0]).filter((p): p is SbSpieler => !!p);
    const k = spieler.map(schluessel);
    const doppelt = spieler.filter((_, i) => k.indexOf(k[i]) !== i);
    if (doppelt.length) { einzelDoppelt = true; hinweiseEinzel.push(`${SEITE[s]}: ${doppelt[0].name} ist mehrfach im Einzel aufgestellt.`); }
    const raenge = spieler.map((p) => p.rang).filter((r): r is number => r != null);
    if (raenge.some((r, i) => i > 0 && r <= raenge[i - 1])) { einzelReihe = false; hinweiseEinzel.push(`${SEITE[s]}: Die Einzel stehen nicht in der Reihenfolge der Meldeliste.`); }
    const nr = mannschaft[s];
    if (nr && nr > 1) {
      for (const p of spieler) if (p.mannschaft != null && p.mannschaft < nr) hinweiseEinzel.push(`${SEITE[s]}: ${p.name} ist für die ${p.mannschaft}. Mannschaft gemeldet – Einsatz in der ${nr}. prüfen.`);
    }
  }
  // Doppel-Aufstellung
  const doppelVoll = d.doppel.every((m) => m.a[0] && m.a[1] && m.b[0] && m.b[1]);
  let doppelDoppelt = false, doppelReihe = true;
  for (const s of ['a', 'b'] as const) {
    const gesehen = new Set<string>();
    const summen: (number | null)[] = [];
    d.doppel.forEach((m, i) => {
      const [x, y] = m[s];
      if (x && y && schluessel(x) === schluessel(y)) { doppelDoppelt = true; hinweiseDoppel.push(`${SEITE[s]}, Doppel ${i + 1}: zweimal derselbe Spieler.`); }
      for (const p of [x, y]) {
        if (!p) continue;
        if (gesehen.has(schluessel(p)) && !(x && y && schluessel(x) === schluessel(y))) { doppelDoppelt = true; hinweiseDoppel.push(`${SEITE[s]}: ${p.name} spielt in mehr als einem Doppel.`); }
        gesehen.add(schluessel(p));
      }
      summen.push(x?.rang != null && y?.rang != null ? x.rang + y.rang : null);
    });
    let letzte = -1;
    for (const z of summen) {
      if (z == null) continue;
      if (z < letzte) { doppelReihe = false; hinweiseDoppel.push(`${SEITE[s]}: Die Positionssumme muss von Doppel 1 an gleich bleiben oder steigen.`); break; }
      letzte = z;
    }
  }
  const fehlerhaft = alle.some((e) => e.status === 'fehler');
  if (fehlerhaft) hinweiseEinzel.push('Mindestens ein Ergebnis ist ungültig – die markierten Felder prüfen.');

  const pruefungen: Pruefung[] = [
    { id: 'einzel_voll', ok: einzelVoll && !einzelDoppelt, text: 'Einzel-Aufstellung vollständig, kein Spieler doppelt' },
    { id: 'einzel_reihe', ok: einzelReihe, text: 'Einzel in der Reihenfolge der Meldeliste' },
    { id: 'doppel_voll', ok: doppelVoll && !doppelDoppelt, text: `${d.doppel.length} Doppel gebildet, kein Spieler doppelt` },
    { id: 'doppel_reihe', ok: doppelReihe, text: 'Doppel-Reihenfolge nach Positionssumme' },
    { id: 'ergebnisse', ok: fertig === anzahl && !fehlerhaft, text: `Alle ${anzahl} Ergebnisse gültig eingetragen (${fertig}/${anzahl})` },
    { id: 'zeiten', ok: /^\d{2}:\d{2}$/.test(d.beginn) && /^\d{2}:\d{2}$/.test(d.ende), text: 'Beginn und Ende eingetragen' },
  ];
  const vergleich = (summe.punkte[0] - summe.punkte[1]) || (summe.saetze[0] - summe.saetze[1]) || (summe.spiele[0] - summe.spiele[1]);
  const entschieden = summe.punkte[0] * 2 > anzahl || summe.punkte[1] * 2 > anzahl;
  const sieger = fertig === anzahl || entschieden ? (vergleich > 0 ? 'a' : vergleich < 0 ? 'b' : 'x') : null;
  return {
    einzel, doppel, summe, summeEinzel, summeDoppel, fertig, anzahl, sieger, entschieden, pruefungen, hinweiseEinzel, hinweiseDoppel,
    vollstaendig: pruefungen.every((p) => p.ok),
  };
}

/** Satzergebnisse als Text, z. B. „6:4 3:6 10:7“ oder „w.o.“ */
export function ergebnisText(m: SbMatch): string {
  if (m.wertung === 'wo') return m.sieger ? `kampflos ${m.sieger === 'a' ? 'Heim' : 'Gast'}` : 'kampflos';
  const t = m.saetze.filter(voll).map((s) => `${s[0]}:${s[1]}`).join(' ');
  return m.wertung === 'aufgabe' ? `${t}${t ? ' ' : ''}Aufg.` : t;
}

/** Saison zum Spieldatum: April–September Sommer, sonst Winter (Oktober bis März) */
export function saisonZu(datum: string): string {
  const j = Number(datum.slice(0, 4)), m = Number(datum.slice(5, 7));
  if (m >= 4 && m <= 9) return `Sommer ${j}`;
  const start = m >= 10 ? j : j - 1;
  return `Winter ${start}/${String(start + 1).slice(2)}`;
}

const ROEMISCH: Record<string, number> = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6 };
/** „TC Oberthal 2“ → Verein „TC Oberthal“, Mannschaft 2; ohne Nummer Mannschaft 1 */
export function vereinUndNummer(team: string): { verein: string; nr: number } {
  const t = team.replace(/\s+/g, ' ').trim();
  const m = /^(.*\S)\s+(\d{1,2}|[IVX]{1,4})\.?$/i.exec(t);
  if (m) {
    const nr = /^\d+$/.test(m[2]) ? Number(m[2]) : ROEMISCH[m[2].toLowerCase()];
    if (nr) return { verein: m[1], nr };
  }
  return { verein: t, nr: 1 };
}
