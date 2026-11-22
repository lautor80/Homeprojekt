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

/** Knoten im Drilldown je Person; die Ebenen ergeben sich aus der gewählten Feldreihenfolge */
export interface Knoten {
  id: string;
  feld: BaumFeld;
  wert: string; // Rohwert des Felds (Typ, Account, JJJJ-MM, Tag …)
  text: string;
  zusatz: string; // z. B. Kunde · Bereich bzw. Ticket
  stunden: number;
  tage: number; // Buchungstage
  eintraege: number[]; // Indizes in Auswertung.eintraege
  kinder: Knoten[];
}

const TYP_TEXT: Record<string, string> = { B: 'Billable', P: 'PreSales', I: 'Intern', A: 'Abwesenheit' };
const TYP_FOLGE = ['B', 'P', 'I', 'A'];
const MONATSNAMEN = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
const WT = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
const r2 = (n: number) => Math.round(n * 100) / 100;
const textNorm = (s: string) => s.replace(/\s+/g, ' ').trim();

/** ISO-Kalenderwoche 'JJJJ-Www' eines Tages */
function kw(tag: string): string {
  const d = new Date(`${tag}T00:00:00Z`);
  const wt = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() + 3 - wt);
  const j = d.getUTCFullYear();
  return `${j}-W${String(Math.floor(Math.round((d.getTime() - Date.UTC(j, 0, 1)) / 86400000) / 7) + 1).padStart(2, '0')}`;
}

/** ein Buchungstag eines Eintrags – Grundlage des Baums (zeitbezogene Felder teilen Einträge nach Tagen auf) */
interface Stueck { e: AuswEintrag; i: number; tag: string; h: number }

interface FeldDef {
  text: string;
  /** Schlüssel und Anzeige des Knotens */
  wert: (s: Stueck) => { key: string; text: string };
  /** Zusatz je Knoten; `gewaehlt` = alle Felder des Baums (Zusatz nur, wenn das Feld nicht selbst Ebene ist) */
  zusatz?: (s: Stueck, gewaehlt: BaumFeld[]) => string[];
  /** feste Sortierung statt Stunden absteigend */
  sort?: (a: Knoten, b: Knoten) => number;
}

const zeitlich = (a: Knoten, b: Knoten) => (a.wert < b.wert ? -1 : a.wert > b.wert ? 1 : 0);

/** Felder, nach denen der Buchungsbaum gruppiert werden kann */
export const BAUM_FELDER = {
  kategorie: {
    text: 'Kategorie',
    wert: ({ e }) => ({ key: e.typ, text: TYP_TEXT[e.typ] ?? e.typ }),
    sort: (a, b) => TYP_FOLGE.indexOf(a.wert) - TYP_FOLGE.indexOf(b.wert),
  },
  projekt: {
    text: 'Projekt (Account)',
    wert: ({ e }) => (e.ohneAccount ? { key: `ber:${e.ber}`, text: e.ber || 'Kein Account' } : { key: e.acc, text: e.accName }),
    zusatz: ({ e }, g) => [g.includes('kunde') ? '' : e.kunde, e.ohneAccount || g.includes('bereich') ? '' : e.ber],
  },
  kunde: { text: 'Kunde', wert: ({ e }) => ({ key: e.kunde.toLowerCase(), text: e.kunde || '(ohne Kunde)' }) },
  bereich: { text: 'Bereich', wert: ({ e }) => ({ key: e.ber.toLowerCase(), text: e.ber || '(ohne Bereich)' }) },
  ticket: {
    text: 'Ticket',
    wert: ({ e }) => ({ key: e.key, text: e.key || '(ohne Ticket)' }),
  },
  taetigkeit: {
    text: 'Tätigkeit (Text)',
    wert: ({ e }) => { const t = textNorm(e.text); return { key: t.toLowerCase(), text: t || '(kein Text)' }; },
    zusatz: ({ e }, g) => [g.includes('ticket') ? '' : e.key],
  },
  monat: {
    text: 'Monat',
    wert: ({ tag }) => ({ key: tag.slice(0, 7), text: `${MONATSNAMEN[Number(tag.slice(5, 7)) - 1]} ${tag.slice(0, 4)}` }),
    sort: zeitlich,
  },
  woche: {
    text: 'Kalenderwoche',
    wert: ({ tag }) => { const w = kw(tag); return { key: w, text: `KW ${Number(w.slice(6))}/${w.slice(0, 4)}` }; },
    sort: zeitlich,
  },
  tag: {
    text: 'Tag',
    wert: ({ tag }) => {
      const wt = WT[(new Date(`${tag}T00:00:00Z`).getUTCDay() + 6) % 7];
      return { key: tag, text: `${wt} ${tag.slice(8, 10)}.${tag.slice(5, 7)}.${tag.slice(0, 4)}` };
    },
    sort: zeitlich,
  },
} satisfies Record<string, FeldDef>;

export type BaumFeld = keyof typeof BAUM_FELDER;
export const BAUM_STANDARD: BaumFeld[] = ['kategorie', 'projekt', 'taetigkeit'];

/** gespeicherte Feldliste prüfen: nur bekannte Felder, jedes einmal, mindestens eines */
export function baumFelderLesen(roh: unknown): BaumFeld[] {
  if (!Array.isArray(roh)) return [...BAUM_STANDARD];
  const r = roh.filter((f, i): f is BaumFeld => typeof f === 'string' && f in BAUM_FELDER && roh.indexOf(f) === i);
  return r.length ? r : [...BAUM_STANDARD];
}

/**
 * Baum der Buchungen einer Person im Zeitraum, gruppiert nach den Feldern in der gegebenen Reihenfolge
 * (Standard: Kategorie → Projekt → Tätigkeit). Gleiche Texte werden zusammengefasst (Leerraum, Groß/klein egal).
 * Zeitbezogene Felder (Monat, Woche, Tag) teilen die Stunden eines Eintrags auf seine Buchungstage auf.
 * Je Ebene nach Stunden absteigend; Kategorie in fester Reihenfolge, Zeitfelder chronologisch.
 */
export function baum(eintraege: { e: AuswEintrag; i: number }[], felder: BaumFeld[] = BAUM_STANDARD): Knoten[] {
  const fl = felder.length ? felder : BAUM_STANDARD;
  const neu = (id: string, feld: BaumFeld, wert: string, text: string): Knoten => ({ id, feld, wert, text, zusatz: '', stunden: 0, tage: 0, eintraege: [], kinder: [] });
  const wurzel = neu('', fl[0], '', '');
  const tageJe = new Map<Knoten, Set<string>>();
  const zusatzJe = new Map<Knoten, string[]>();
  const kindIndex = new Map<Knoten, Map<string, Knoten>>();
  const add = (k: Knoten, s: Stueck) => {
    k.stunden += s.h;
    if (!k.eintraege.includes(s.i)) k.eintraege.push(s.i);
    let t = tageJe.get(k);
    if (!t) tageJe.set(k, (t = new Set()));
    t.add(s.tag);
  };
  for (const { e, i } of eintraege) {
    if (!e.stunden) continue;
    for (const [tag, h] of e.tage) {
      if (!h) continue;
      const s: Stueck = { e, i, tag, h };
      let k = wurzel;
      for (const feld of fl) {
        const def: FeldDef = BAUM_FELDER[feld];
        const w = def.wert(s);
        let idx = kindIndex.get(k);
        if (!idx) kindIndex.set(k, (idx = new Map()));
        let c = idx.get(w.key);
        if (!c) {
          c = neu(`${k.id ? `${k.id}|` : ''}${feld}:${w.key}`, feld, w.key, w.text);
          idx.set(w.key, c);
          k.kinder.push(c);
        }
        for (const z of def.zusatz?.(s, fl) ?? []) {
          if (!z) continue;
          const l = zusatzJe.get(c) ?? [];
          if (!l.includes(z)) { l.push(z); zusatzJe.set(c, l); }
        }
        add(c, s);
        k = c;
      }
    }
  }
  const fertig = (ks: Knoten[]): Knoten[] => {
    const r = ks.map((k) => ({ ...k, stunden: r2(k.stunden), tage: tageJe.get(k)?.size ?? 0, zusatz: zusatzText(k.feld, zusatzJe.get(k) ?? []), kinder: fertig(k.kinder) }));
    const sort = r.length ? (BAUM_FELDER[r[0].feld] as FeldDef).sort : undefined;
    return r.sort((x, y) => (sort ? sort(x, y) : 0) || y.stunden - x.stunden || x.text.localeCompare(y.text, 'de'));
  };
  return fertig(wurzel.kinder);
}

/** Projekt: „Kunde · Bereich“ (einmal je Wert), sonst Liste mit Komma (z. B. Tickets) */
function zusatzText(feld: BaumFeld, l: string[]): string {
  return feld === 'projekt' ? l.join(' · ') : l.join(', ');
}
