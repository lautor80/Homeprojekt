import type { AuswEintrag, Auswertung, Fund, FundGruppe, Kategorie, PersonAuswertung, Stufe } from '../server/typen';

/** clientseitige Filter der Zeitenkontrolle (Zeitraum und Stichtag gehen an den Server) */
export interface Filter {
  team: string;
  standort: string;
  stufe: Stufe;
  person: string;
  suche: string;
}
export const FILTER_START: Filter = { team: '', standort: '', stufe: 2, person: '', suche: '' };

/** Fundgruppe, eingeschränkt auf bestimmte Kategorien und die Stufe */
export interface Zeile extends FundGruppe { alle: Fund[] }

export interface Sicht {
  a: Auswertung;
  f: Filter;
  /** sichtbare Personen (nie ausgeblendete), nach Team, dann Offen absteigend */
  personen: PersonAuswertung[];
  person: Map<string, PersonAuswertung>;
  /** alle Gruppen der sichtbaren Personen, ohne Stufenfilter */
  gruppen: FundGruppe[];
  /** Einträge der sichtbaren Personen mit Index in a.eintraege */
  eintraege: { e: AuswEintrag; i: number }[];
  /** Auswahllisten (nur nicht ausgeblendete Personen) */
  teams: string[];
  standorte: string[];
  alleSichtbar: PersonAuswertung[];
  /** Fund freigeben (Text gilt für Regel und Account als in Ordnung); fehlt ohne Recht */
  freigeben?: (eintrag: AuswEintrag, fund: Fund) => void;
}

export function sichtBerechnen(a: Auswertung, f: Filter): Sicht {
  const alleSichtbar = a.personen.filter((p) => !p.ausgeblendet);
  const suche = f.suche.trim().toLowerCase();
  const personen = alleSichtbar
    .filter((p) => (!f.team || p.team === f.team) && (!f.standort || p.standort === f.standort) && (!f.person || p.person === f.person)
      && (!suche || p.person.toLowerCase().includes(suche)))
    .sort((x, y) => x.team.localeCompare(y.team, 'de') || y.offen - x.offen || x.person.localeCompare(y.person, 'de'));
  const person = new Map(personen.map((p) => [p.person, p]));
  return {
    a, f, personen, person, alleSichtbar,
    gruppen: a.gruppen.filter((g) => person.has(g.person)),
    eintraege: a.eintraege.map((e, i) => ({ e, i })).filter(({ e }) => person.has(e.person)),
    teams: [...new Set(alleSichtbar.map((p) => p.team))].sort((x, y) => x.localeCompare(y, 'de')),
    standorte: [...new Set(alleSichtbar.map((p) => p.standort))].sort(),
  };
}

/**
 * Fundlisten eines Reiters: je Gruppe nur die Funde der Kategorien ab der Stufe („Einzelfehler“);
 * eine Gruppe erscheint, wenn mindestens ein solcher Fund bleibt. Stufe der Zeile = Maximum.
 */
export function zeilen(gruppen: FundGruppe[], kategorien: Kategorie[], stufe: Stufe): Zeile[] {
  const out: Zeile[] = [];
  for (const g of gruppen) {
    const alle = g.funde.filter((x) => kategorien.includes(x.kategorie));
    const funde = alle.filter((x) => x.stufe >= stufe);
    if (!funde.length) continue;
    out.push({ ...g, alle, funde, stufe: Math.max(...funde.map((x) => x.stufe)) as Stufe });
  }
  return out.sort((x, y) => y.stufe - x.stufe || y.stunden - x.stunden);
}

/** Gruppen, die mindestens einen Fund einer der Kategorien haben (ohne Stufenfilter) */
export const mitKategorie = (gruppen: FundGruppe[], k: Kategorie[]) => gruppen.filter((g) => g.funde.some((x) => k.includes(x.kategorie)));

/** Tage eines Funds bzw. einer Gruppe: Tag des Tagesfunds oder Tage des Eintrags im Zeitraum */
export function tageVon(a: Auswertung, g: { eintrag: number | null; tag: string | null }): string[] {
  if (g.tag) return [g.tag];
  if (g.eintrag === null) return [];
  return (a.eintraege[g.eintrag]?.tage ?? []).map(([t]) => t);
}

/** Summen über Personen */
export function summen(ps: PersonAuswertung[]) {
  const s = { n: 0, ok: 0, soll: 0, ist: 0, offen: 0, fehltage: 0, B: 0, P: 0, I: 0, A: 0, ent: 0, entBad: 0, kHoch: 0, k: 0, r: 0 };
  for (const p of ps) {
    if (p.aktiv) { s.n++; if (p.vollstaendig) s.ok++; }
    s.soll += p.soll; s.ist += p.ist; s.offen += p.offen; s.fehltage += p.fehltage;
    s.B += p.B; s.P += p.P; s.I += p.I; s.A += p.A;
    s.ent += p.eintraegeZeitraum;
    s.entBad += p.texteUnauffaellig === null ? 0 : Math.round((1 - p.texteUnauffaellig) * p.eintraegeZeitraum);
    s.k += p.kontierung[0]; s.kHoch += p.kontierung[3]; s.r += p.regelwerk[0];
  }
  return s;
}
export const unauffaellig = (s: { ent: number; entBad: number }) => (s.ent ? 1 - s.entBad / s.ent : null);
