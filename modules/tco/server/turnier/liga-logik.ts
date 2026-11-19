/**
 * Monats-Gruppenliga: reine Logik ohne Datenbank (Gruppenschnitt, Spielplan, Gruppentabelle, Auf-/Abstieg,
 * Neueinsteiger, Gesamtwertung). Wird von liga.ts und den Tests benutzt.
 */
import type { LigaEinstellungen, Runde, Spiel, Teilnehmer } from './typen.js';
import { bilanzen, einzelAuswerten, gewertet, type Bilanz } from './wertung.js';

/**
 * Gruppengrößen für n Personen bei gewünschter Gruppengröße g (4 oder 5). Gruppe 1 = stärkste.
 *
 * Regel: alle Gruppen sind 4 oder 5 groß. Bei g = 4 werden so viele 4er-Gruppen gebildet wie möglich und der Rest
 * (1–3 Personen) auf die untersten Gruppen verteilt (die werden zu 5er-Gruppen); bei g = 5 entsprechend so viele
 * 5er-Gruppen wie möglich, die nötigen 4er-Gruppen stehen unten. Abweichende Gruppen also immer unten.
 *
 * Sonderfälle, in denen das nicht aufgeht:
 *  - n ≤ 3: eine Gruppe mit allen (bei 1 Person keine Gruppe – Liga braucht mindestens 2),
 *  - n = 6: eine 6er-Gruppe (zwei 3er-Gruppen hätten nur je 2 Spiele im Monat),
 *  - n = 7: 4er-Gruppe + 3er-Gruppe als letzte,
 *  - n = 11: 4 + 4 + 3 (3er-Gruppe als letzte).
 * Ab 12 Personen geht es bei beiden Gruppengrößen immer mit 4ern und 5ern auf.
 */
export function gruppenGroessen(n: number, g: 4 | 5): number[] {
  if (n < 2) return [];
  if (n <= 3) return [n];
  if (n === 6) return [6];
  if (n === 7) return [4, 3];
  if (n === 11) return [4, 4, 3];
  if (g === 4) {
    const k = Math.floor(n / 4), r = n - 4 * k; // r ≤ k ist hier gesichert (n ∉ {6, 7, 11})
    return Array.from({ length: k }, (_, i) => (i >= k - r ? 5 : 4));
  }
  const k = Math.ceil(n / 5), d = 5 * k - n; // d Gruppen mit 4
  return Array.from({ length: k }, (_, i) => (i >= k - d ? 4 : 5));
}

/** sortierte Liste (stärkste zuerst) in Gruppen schneiden; Ergebnis[0] = Gruppe 1 */
export function gruppenSchneiden<T>(liste: T[], g: 4 | 5): T[][] {
  const out: T[][] = [];
  let i = 0;
  for (const n of gruppenGroessen(liste.length, g)) { out.push(liste.slice(i, i + n)); i += n; }
  return out;
}

/**
 * Jeder gegen jeden nach dem Kreisverfahren: Spiele so geordnet, dass jede Person möglichst gleichmäßig verteilt
 * spielt (Spieltag für Spieltag). Seite a wechselt, damit niemand immer „oben“ steht.
 */
export function jederGegenJeden<T>(ids: T[]): [T, T][] {
  const l: (T | null)[] = [...ids];
  if (l.length < 2) return [];
  if (l.length % 2) l.push(null);
  const n = l.length, out: [T, T][] = [];
  for (let r = 0; r < n - 1; r++) {
    for (let i = 0; i < n / 2; i++) {
      const x = l[i], y = l[n - 1 - i];
      if (x === null || y === null) continue;
      out.push((r + i) % 2 ? [y, x] : [x, y]);
    }
    l.splice(1, 0, l.pop()!); // erste Position fest, Rest rotiert
  }
  return out;
}

export type Kennzeichen = 'auf' | 'ab' | null;

export interface TabellenZeile {
  teilnehmer_id: number;
  platz: number;
  /** Startposition in der Gruppe (0 = stärkste) */
  pos: number;
  spiele: number;
  siege: number;
  niederlagen: number;
  saetze: [number, number];
  spielstand: [number, number];
  /** noch offene Spiele */
  offen: number;
  /** ▲ Platz 1 (außer Gruppe 1), ▼ Letzter (außer letzte Gruppe) */
  kennzeichen: Kennzeichen;
}

type SpielKurz = Pick<Spiel, 'feld' | 'a' | 'b' | 'saetze' | 'wertung' | 'sieger'>;

/**
 * Gruppentabelle. ids in Startreihenfolge. Reihenfolge: Siege, Satzdifferenz, Spieldifferenz, direkter Vergleich
 * (bei mehr als zwei Gleichen: Siege in den Spielen untereinander), Startposition.
 */
export function gruppenTabelle(ids: number[], spiele: SpielKurz[], o: { gruppe: number; gruppen: number }): TabellenZeile[] {
  const drin = new Set(ids);
  const eigene = spiele.filter((s) => s.a.length === 1 && s.b.length === 1 && drin.has(s.a[0]) && drin.has(s.b[0]));
  const bil = bilanzen(eigene, ids);
  const offen = new Map<number, number>(ids.map((i) => [i, 0]));
  for (const s of eigene) if (s.wertung === 'offen') for (const i of [s.a[0], s.b[0]]) offen.set(i, (offen.get(i) ?? 0) + 1);
  const pos = new Map(ids.map((id, i) => [id, i]));
  const schluessel = (b: Bilanz) => [b.siege, b.saetze[0] - b.saetze[1], b.spielstand[0] - b.spielstand[1]].join('|');
  const grund = (x: number, y: number) => {
    const bx = bil.get(x)!, by = bil.get(y)!;
    return by.siege - bx.siege || (by.saetze[0] - by.saetze[1]) - (bx.saetze[0] - bx.saetze[1])
      || (by.spielstand[0] - by.spielstand[1]) - (bx.spielstand[0] - bx.spielstand[1]);
  };
  const sortiert = [...ids].sort((x, y) => grund(x, y) || pos.get(x)! - pos.get(y)!);
  // direkter Vergleich innerhalb gleicher Blöcke
  const ergebnis: number[] = [];
  for (let i = 0; i < sortiert.length;) {
    let j = i + 1;
    while (j < sortiert.length && schluessel(bil.get(sortiert[j])!) === schluessel(bil.get(sortiert[i])!)) j++;
    const block = sortiert.slice(i, j);
    if (block.length > 1) {
      const bs = new Set(block);
      const unter = eigene.filter((s) => bs.has(s.a[0]) && bs.has(s.b[0]));
      const siege = new Map(block.map((id) => [id, 0]));
      for (const s of unter) {
        if (!gewertet(s)) continue;
        const e = einzelAuswerten(s.wertung, s.saetze, s.sieger === 'x' ? null : s.sieger);
        if (e.sieger === 'a') siege.set(s.a[0], siege.get(s.a[0])! + 1);
        if (e.sieger === 'b') siege.set(s.b[0], siege.get(s.b[0])! + 1);
      }
      block.sort((x, y) => siege.get(y)! - siege.get(x)! || pos.get(x)! - pos.get(y)!);
    }
    ergebnis.push(...block);
    i = j;
  }
  return ergebnis.map((id, i) => {
    const b = bil.get(id)!;
    const kennzeichen: Kennzeichen = ergebnis.length < 2 ? null
      : i === 0 && o.gruppe > 1 ? 'auf'
        : i === ergebnis.length - 1 && o.gruppe < o.gruppen ? 'ab' : null;
    return { teilnehmer_id: id, platz: i + 1, pos: pos.get(id)!, spiele: b.spiele, siege: b.siege, niederlagen: b.niederlagen,
      saetze: b.saetze, spielstand: b.spielstand, offen: offen.get(id) ?? 0, kennzeichen };
  });
}

export type Merkmal = 'auf' | 'ab' | 'neu' | null;
export interface Einsortiert {
  id: number;
  merkmal: Merkmal;
  /** Auf-/Absteiger: Zielgruppe (0 = Gruppe 1) */
  ziel?: number;
}
type Staerke = Pick<Teilnehmer, 'id' | 'lk' | 'rang'>;

/**
 * Reihenfolge für die nächste Runde aus dem Endstand der Vorrunde.
 *  1. endstand: je Gruppe (Gruppe 1 zuerst) die Teilnehmer-IDs in Tabellenreihenfolge.
 *  2. Erster der Gruppe k (k > 1) tauscht mit dem Letzten der Gruppe k−1: in der Gesamtliste steht der Aufsteiger
 *     danach am Ende der oberen, der Absteiger am Anfang der unteren Gruppe.
 *  3. Wer nicht mehr aktiv ist (abgemeldet), fällt heraus.
 *  4. Neueinsteiger (aktiv, aber nicht in der Vorrunde) werden nach Stärke einsortiert: Position = Anzahl der Personen
 *     in der Liste mit gleicher oder besserer LK (bei manueller Setzung und vorhandenem Rang: Rang). Weil die Liste nach
 *     Auf-/Abstiegen nicht mehr streng nach LK sortiert ist, ist das robuster als „vor die erste schwächere LK“.
 *     Ohne Vergleichswert ans Ende.
 * Danach schneidet einteilen() die Liste neu – Auf-/Absteiger bleiben dabei in ihrer Zielgruppe.
 */
export function naechsteReihenfolge(endstand: number[][], aktive: Staerke[], setzung: 'lk' | 'manuell'): Einsortiert[] {
  const merkmal = new Map<number, Merkmal>();
  const ziel = new Map<number, number>();
  const g = endstand.map((x) => [...x]);
  for (let k = 1; k < g.length; k++) {
    const oben = endstand[k - 1], unten = endstand[k];
    if (oben.length < 2 || unten.length < 2) continue;
    const auf = unten[0], ab = oben[oben.length - 1];
    g[k - 1][g[k - 1].length - 1] = auf;
    g[k][0] = ab;
    merkmal.set(auf, 'auf'); merkmal.set(ab, 'ab');
    ziel.set(auf, k - 1); ziel.set(ab, k);
  }
  const info = new Map(aktive.map((t) => [t.id, t]));
  const liste: Einsortiert[] = g.flat().filter((id) => info.has(id)).map((id) => (ziel.has(id) ? { id, merkmal: merkmal.get(id)!, ziel: ziel.get(id)! } : { id, merkmal: null }));
  const bekannt = new Set(liste.map((x) => x.id));
  const neue = aktive.filter((t) => !bekannt.has(t.id));
  const wert = (t: Staerke, art: 'rang' | 'lk') => (art === 'rang' ? t.rang : t.lk);
  const artFuer = (t: Staerke): 'rang' | 'lk' | null => (setzung === 'manuell' && t.rang != null ? 'rang' : t.lk != null ? 'lk' : null);
  // stärkste Neue zuerst einsortieren (gleiche Werte: Meldereihenfolge der Eingabe)
  const sortiert = [...neue].sort((x, y) => {
    const ax = artFuer(x), ay = artFuer(y);
    if (!ax || !ay) return (ax ? 0 : 1) - (ay ? 0 : 1);
    return ax === ay ? wert(x, ax)! - wert(y, ay)! : 0;
  });
  for (const n of sortiert) {
    const art = artFuer(n);
    let i = liste.length;
    if (art) {
      const v = wert(n, art)!;
      i = liste.filter((x) => { const w = wert(info.get(x.id)!, art); return w != null && w <= v; }).length;
    }
    liste.splice(i, 0, { id: n.id, merkmal: 'neu' });
  }
  return liste;
}

/**
 * Liste schneiden und Auf-/Absteiger in ihrer Zielgruppe halten: Durch Abmeldungen oder Neueinsteiger verschieben sich
 * die Gruppengrenzen; ein Aufsteiger, der dadurch wieder eine Gruppe tiefer landen würde, tauscht mit dem Letzten der
 * Zielgruppe, der weder auf- noch abgestiegen ist (Absteiger entsprechend mit dem Ersten der Gruppe darunter).
 * Die Gruppengrößen bleiben dabei unverändert.
 */
export function einteilen(liste: Einsortiert[], g: 4 | 5): Einsortiert[][] {
  const gr = gruppenSchneiden(liste, g);
  const fest = (x: Einsortiert) => x.ziel === undefined;
  for (let k = 0; k < gr.length; k++) {
    for (const x of [...gr[k]]) {
      if (x.ziel === undefined || x.ziel >= gr.length || x.ziel === k) continue;
      if (x.merkmal === 'auf' && x.ziel === k - 1) {
        const oben = gr[k - 1];
        const j = oben.map(fest).lastIndexOf(true);
        if (j < 0) continue;
        const y = oben[j];
        oben.splice(j, 1); oben.push(x);
        gr[k].splice(gr[k].indexOf(x), 1); gr[k].unshift(y);
      } else if (x.merkmal === 'ab' && x.ziel === k + 1) {
        const unten = gr[k + 1];
        const j = unten.findIndex(fest);
        if (j < 0) continue;
        const y = unten[j];
        unten.splice(j, 1); unten.unshift(x);
        gr[k].splice(gr[k].indexOf(x), 1); gr[k].push(y);
      }
    }
  }
  return gr;
}

export interface GesamtZeile extends Bilanz { platz: number }

/** Gesamtwertung über alle Runden: Siegquote, dann Siege, Satzdifferenz, Spieldifferenz (ohne gewertete Spiele ans Ende) */
export function gesamtWertung(spiele: SpielKurz[], ids: number[]): GesamtZeile[] {
  const b = [...bilanzen(spiele.filter((s) => s.feld === 'gruppe'), ids).values()];
  b.sort((x, y) => (y.spiele ? 1 : 0) - (x.spiele ? 1 : 0) || y.quote - x.quote || y.siege - x.siege
    || (y.saetze[0] - y.saetze[1]) - (x.saetze[0] - x.saetze[1]) || (y.spielstand[0] - y.spielstand[1]) - (x.spielstand[0] - x.spielstand[1])
    || ids.indexOf(x.teilnehmer_id) - ids.indexOf(y.teilnehmer_id));
  return b.map((x, i) => ({ ...x, platz: i + 1 }));
}

/** Monat JJJJ-MM-01 aus „JJJJ-MM“ bzw. Folgemonat eines Datums */
export function monatAusStart(start: string): string | null {
  const m = /^(\d{4})-(\d{2})$/.exec(start ?? '');
  if (!m || +m[2] < 1 || +m[2] > 12) return null;
  return `${m[1]}-${m[2]}-01`;
}
export function folgemonat(monat: string): string {
  const [j, m] = monat.slice(0, 7).split('-').map(Number);
  return m === 12 ? `${j + 1}-01-01` : `${j}-${String(m + 1).padStart(2, '0')}-01`;
}

// ------------------------------------------------------------------ Datenformen (Server ↔ Oberfläche)
/** GET /turniere/:id/liga/vorschau */
export interface Vorschau {
  moeglich: boolean;
  hinweis: string | null;
  nr: number;
  monat: string | null;
  gruppen: { gruppe: number; personen: { id: number; merkmal: Merkmal }[] }[];
}

/** daten der Live-Route */
export interface LigaGruppe {
  gruppe: number;
  tabelle: TabellenZeile[];
  spiele: Pick<Spiel, 'id' | 'gruppe' | 'pos' | 'a' | 'b' | 'saetze' | 'wertung' | 'sieger' | 'bemueht'>[];
}
export interface LigaRunde { nr: number; monat: string | null; status: Runde['status']; spiele: number; offen: number; gruppen: LigaGruppe[] }
export interface LigaLiveDaten {
  einstellungen: LigaEinstellungen;
  /** Nummer der aktuellen (letzten) Runde, null = noch keine */
  aktuell: number | null;
  runden: LigaRunde[];
  gesamt: GesamtZeile[];
  /** je Teilnehmer: Gruppe je Monat */
  verlauf: Record<number, { nr: number; monat: string | null; gruppe: number }[]>;
}
