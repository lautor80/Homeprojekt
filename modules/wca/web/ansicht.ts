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

/** Knoten im Drilldown je Person: Kategorie (Typ) → Projekt (Account) → Tätigkeit (Text) */
export interface Knoten {
  id: string;
  text: string;
  zusatz: string; // z. B. Kunde · Bereich bzw. Ticket
  stunden: number;
  tage: number; // Buchungstage
  eintraege: number[]; // Indizes in Auswertung.eintraege
  kinder: Knoten[];
}

const TYP_TEXT: Record<string, string> = { B: 'Billable', P: 'PreSales', I: 'Intern', A: 'Abwesenheit' };
const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Baum der Buchungen einer Person im Zeitraum: Kategorie (Billable, PreSales, Intern, Abwesenheit) → Projekt (Account,
 * ohne Account der Bereich) → Tätigkeit (gleicher Text zusammengefasst). Je Ebene nach Stunden absteigend.
 */
export function baum(eintraege: { e: AuswEintrag; i: number }[]): Knoten[] {
  const neu = (id: string, text: string, zusatz = ''): Knoten => ({ id, text, zusatz, stunden: 0, tage: 0, eintraege: [], kinder: [] });
  const kats = new Map<string, Knoten>();
  const tageJe = new Map<Knoten, Set<string>>();
  const add = (k: Knoten, e: AuswEintrag, i: number) => {
    k.stunden += e.stunden;
    k.eintraege.push(i);
    const s = tageJe.get(k) ?? new Set<string>();
    for (const [t] of e.tage) s.add(t);
    tageJe.set(k, s);
  };
  for (const { e, i } of eintraege) {
    if (!e.stunden) continue;
    let kat = kats.get(e.typ);
    if (!kat) { kat = neu(e.typ, TYP_TEXT[e.typ] ?? e.typ); kats.set(e.typ, kat); }
    const projName = e.ohneAccount ? (e.ber || 'Kein Account') : e.accName;
    const projId = `${e.typ}|${e.ohneAccount ? `ber:${e.ber}` : e.acc}`;
    let proj = kat.kinder.find((k) => k.id === projId);
    if (!proj) { proj = neu(projId, projName, [e.kunde, e.ohneAccount ? '' : e.ber].filter(Boolean).join(' · ')); kat.kinder.push(proj); }
    const tText = e.text.replace(/\s+/g, ' ').trim();
    const tId = `${projId}|${tText.toLowerCase()}`;
    let t = proj.kinder.find((k) => k.id === tId);
    if (!t) { t = neu(tId, tText || '(kein Text)', e.key); proj.kinder.push(t); }
    else if (e.key && !t.zusatz.split(', ').includes(e.key)) t.zusatz = t.zusatz ? `${t.zusatz}, ${e.key}` : e.key;
    add(kat, e, i); add(proj, e, i); add(t, e, i);
  }
  const fertig = (ks: Knoten[]): Knoten[] => ks
    .map((k) => ({ ...k, stunden: r2(k.stunden), tage: tageJe.get(k)?.size ?? 0, kinder: fertig(k.kinder) }))
    .sort((x, y) => y.stunden - x.stunden || x.text.localeCompare(y.text, 'de'));
  const reihenfolge = ['B', 'P', 'I', 'A'];
  return fertig([...kats.values()]).sort((x, y) => reihenfolge.indexOf(x.id) - reihenfolge.indexOf(y.id));
}
