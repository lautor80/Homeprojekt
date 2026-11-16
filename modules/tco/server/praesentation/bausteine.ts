/**
 * Inhalte für Präsentationen (#146): Kennzahlen, Diagramme und Tabellen aus der Vereinsübersicht und den Finanzberichten,
 * jeweils unter einem festen Schlüssel – dieselben Schlüssel gelten für den Sammelkorb und für Platzhalter in eigenen Vorlagen.
 *
 *   Kennzahl   {{SCHLUESSEL}} Wert, {{SCHLUESSEL.einheit}}, {{SCHLUESSEL.titel}}, {{SCHLUESSEL.text}} (Untertitel)
 *   Diagramm   Objekt mit Namen/Alternativtext {{DIAGRAMM:SCHLUESSEL}}
 *   Tabelle    Objekt mit Namen/Alternativtext {{TABELLE:SCHLUESSEL}}
 *   allgemein  {{verein.name}}, {{stand.datum}}, {{jahr}}, {{praesentation.titel}}, {{praesentation.untertitel}}, {{liq.*}}
 * Es wird nur gelesen.
 */
import type { Db } from '../verein.js';
import { vereinLesen } from '../verein.js';
import { dat, heute } from '../format.js';
import {
  collectClubhaus, collectFinanzen, collectHalle, collectJugend, collectMitglieder,
  detailBeitragswechsel, detailClubhausOp, detailClubhausUmsatz, detailHalleOffen, type Kpi,
} from '../dashboard/kpi.js';
import { chartClubhaus, chartHalleJahre, chartMtgJahre, chartMtgMonate } from '../dashboard/charts.js';
import { liquiditaet, monatsverlauf } from '../dashboard/finanzen.js';
import { benutzerVerlauf } from '../dashboard/benutzer.js';
import type { Diagramm, Tabelle } from './pptx.js';
import { gueltigerPlan, planLesen, sollIst } from '../haushalt/logik.js';

export type DiagrammArt = 'LINIE' | 'SAEULEN';
export interface KatalogEintrag { key: string; titel: string; bereich: string; art?: DiagrammArt }
export interface Katalog { kpis: KatalogEintrag[]; diagramme: KatalogEintrag[]; tabellen: KatalogEintrag[] }

const MON = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
/** ohne Haushaltsplan: eine leere Reihe statt eines Diagramms ohne Daten */
const OHNE_PLAN = [{ name: 'kein Haushaltsplan', werte: Array.from({ length: 12 }, () => 0) }];
const de = (v: number, nk = 2) => v.toLocaleString('de-DE', { minimumFractionDigits: nk, maximumFractionDigits: nk });

interface DiagrammDef { titel: string; bereich: string; art: DiagrammArt; laden: (db: Db, jahr: number) => Promise<Diagramm> }
export const DIAGRAMME: Record<string, DiagrammDef> = {
  MTG_MONATE: {
    titel: 'Mitgliederentwicklung je Monat', bereich: 'Mitglieder', art: 'LINIE',
    laden: async (db, j) => { const d = await chartMtgMonate(db, j); return { kategorien: MON, serien: [{ name: 'Mitglieder', werte: d.map((x) => x.val_line) }] }; },
  },
  MTG_EIN_AUS: {
    titel: 'Eintritte und Austritte je Monat', bereich: 'Mitglieder', art: 'SAEULEN',
    laden: async (db, j) => { const d = await chartMtgMonate(db, j); return { kategorien: MON, serien: [{ name: 'Eintritte', werte: d.map((x) => x.bar_pos) }, { name: 'Austritte', werte: d.map((x) => -x.bar_neg) }] }; },
  },
  MTG_JAHRE: {
    titel: 'Mitglieder der letzten Jahre', bereich: 'Mitglieder', art: 'LINIE',
    laden: async (db) => { const d = await chartMtgJahre(db); return { kategorien: d.map((x) => x.label), serien: [{ name: 'Mitglieder zum Jahresende', werte: d.map((x) => x.val_line) }] }; },
  },
  FIN_MONATE: {
    titel: 'Einnahmen und Ausgaben je Monat', bereich: 'Finanzen', art: 'SAEULEN',
    laden: async (db, j) => { const v = (await monatsverlauf(db, [j])).verlauf; return { kategorien: MON, serien: [{ name: 'Einnahmen', werte: v.map((x) => x.einnahmen) }, { name: 'Ausgaben', werte: v.map((x) => x.ausgaben) }] }; },
  },
  FIN_BESTAND: {
    titel: 'Kontostand je Monatsende', bereich: 'Finanzen', art: 'LINIE',
    laden: async (db, j) => {
      const v = (await monatsverlauf(db, [j])).verlauf.filter((x) => !x.zukunft);
      return { kategorien: v.map((x) => MON[x.monat - 1]), serien: [{ name: 'Kontostand', werte: v.map((x) => x.bestand) }, { name: 'inkl. offener Rechnungen', werte: v.map((x) => x.bestand + x.offen) }] };
    },
  },
  CLUBHAUS: {
    titel: 'Clubheimerträge je Monat', bereich: 'Clubhaus', art: 'LINIE',
    laden: async (db, j) => { const d = await chartClubhaus(db, j); return { kategorien: MON, serien: [{ name: 'Umsatz VK brutto', werte: d.map((x) => x.val1) }, { name: 'Rohertrag', werte: d.map((x) => x.val2) }] }; },
  },
  HAL_JAHRE: {
    titel: 'Hallenbuchungen der letzten fünf Jahre (Stunden)', bereich: 'Halle', art: 'SAEULEN',
    laden: async (db) => { const d = await chartHalleJahre(db); return { kategorien: d.map((x) => x.label), serien: [{ name: 'Gebuchte Stunden', werte: d.map((x) => x.val1) }] }; },
  },
  // Haushaltsplan: gültige Fassung des Jahres (ohne Plan bleibt das Diagramm leer)
  HH_SOLLIST: {
    titel: 'Haushaltsplan: Ausgaben Plan und Ist, aufgelaufen', bereich: 'Finanzen', art: 'LINIE',
    laden: async (db, j) => {
      const s = await sollIst(db, j);
      const bis = s.verlauf.A.ist.filter((x) => x !== null).length;
      return { kategorien: MON, serien: s.plan ? [{ name: 'Plan', werte: s.verlauf.A.plan }, { name: 'Ist', werte: s.verlauf.A.ist.slice(0, bis).map((x) => x ?? 0) }] : OHNE_PLAN };
    },
  },
  HH_LIQ: {
    titel: 'Haushaltsplan: Geldbestand je Monatsende laut Plan', bereich: 'Finanzen', art: 'LINIE',
    laden: async (db, j) => {
      const p = await gueltigerPlan(db, j);
      if (!p) return { kategorien: MON, serien: OHNE_PLAN };
      const l = (await planLesen(db, p.id)).liquiditaet;
      return { kategorien: MON, serien: [{ name: 'Geldbestand laut Plan', werte: l.monate.map((m) => m.bestand) },
        ...(l.mindestreserve !== null ? [{ name: 'Mindestreserve', werte: l.monate.map(() => l.mindestreserve!) }] : [])] };
    },
  },
  BENUTZER: {
    titel: 'Registrierte Portal-Benutzer (24 Monate)', bereich: 'Portal', art: 'LINIE',
    laden: async (db) => {
      const v = await benutzerVerlauf(db, 'MONAT', heute());
      return { kategorien: v.punkte.map((x) => x.label), serien: [{ name: 'Benutzer gesamt', werte: v.punkte.map((x) => x.gesamt) }, { name: 'davon Mitglieder', werte: v.punkte.map((x) => x.mitglieder) }] };
    },
  },
};

export const TABELLEN: Record<string, { titel: string; bereich: string }> = {
  HAL_ABR: { titel: 'Offene Hallenstunden', bereich: 'Halle' },
  CLUB_OP: { titel: 'Offene Posten Clubhaus', bereich: 'Clubhaus' },
  CLUB_UMSATZ: { titel: 'Clubhaus: Umsatz je Monat', bereich: 'Clubhaus' },
  MTG_JUBILAEUM: { titel: 'Beitragsstufenwechsel', bereich: 'Mitglieder' },
  HH_PLAN: { titel: 'Haushaltsplan nach Tätigkeitsbereichen', bereich: 'Finanzen' },
};

async function alleKpis(db: Db, jahr: number): Promise<(Kpi & { bereich: string })[]> {
  const b: [string, Kpi[]][] = [
    ['Mitglieder', await collectMitglieder(db, jahr)], ['Finanzen', await collectFinanzen(db, jahr)], ['Clubhaus', await collectClubhaus(db, jahr)],
    ['Jugend', await collectJugend(db, jahr)], ['Halle', await collectHalle(db)],
  ];
  return b.flatMap(([bereich, l]) => l.filter((k) => !k.todo).map((k) => ({ ...k, bereich })));
}

export async function katalog(db: Db, jahr: number): Promise<Katalog> {
  return {
    kpis: (await alleKpis(db, jahr)).map((k) => ({ key: k.key, titel: k.title, bereich: k.bereich })),
    diagramme: Object.entries(DIAGRAMME).map(([key, d]) => ({ key, titel: d.titel, bereich: d.bereich, art: d.art })),
    tabellen: Object.entries(TABELLEN).map(([key, t]) => ({ key, titel: t.titel, bereich: t.bereich })),
  };
}

/** Haushaltsplan des Jahres (gültige Fassung): Einnahmen, Ausgaben und Ergebnis je Tätigkeitsbereich, Vorhaben, Summe */
async function tabelleHaushalt(db: Db, jahr: number): Promise<Tabelle> {
  const kopf = ['Tätigkeitsbereich', 'Einnahmen', 'Ausgaben', 'Ergebnis'];
  const p = await gueltigerPlan(db, jahr);
  if (!p) return { kopf, zeilen: [[`Für ${jahr} gibt es keinen Haushaltsplan`, '', '', '']] };
  const s = await planLesen(db, p.id);
  const z = (t: string, e: number, a: number) => [t, de(e), de(a), de(e - a)];
  return {
    kopf, zeilen: [
      ...s.bereiche.map((b) => z(b.text, b.einnahmen, b.ausgaben)),
      ...(s.summen.vorhaben_e || s.summen.vorhaben_a ? [z('Einmalige Vorhaben', s.summen.vorhaben_e, s.summen.vorhaben_a)] : []),
      z(`Haushaltsplan ${jahr} (${p.status_text})`, s.summen.einnahmen, s.summen.ausgaben),
    ],
  };
}

export async function tabelleLaden(db: Db, key: string, jahr: number): Promise<Tabelle | undefined> {
  if (key === 'HH_PLAN') return tabelleHaushalt(db, jahr);
  const d = key === 'HAL_ABR' ? await detailHalleOffen(db) : key === 'CLUB_OP' ? await detailClubhausOp(db, jahr)
    : key === 'CLUB_UMSATZ' ? await detailClubhausUmsatz(db, jahr) : key === 'MTG_JUBILAEUM' ? await detailBeitragswechsel(db) : null;
  if (!d) return undefined;
  return { kopf: d.head, zeilen: d.zeilen.map((z) => z.cols) };
}

export async function diagrammLaden(db: Db, key: string, jahr: number): Promise<Diagramm | undefined> {
  return DIAGRAMME[key]?.laden(db, jahr);
}

export interface Daten {
  werte: Map<string, string>;
  kpis: Map<string, Kpi & { bereich: string }>;
}

/** Werte für Platzhalter: allgemeine Angaben, alle Kennzahlen, Liquidität; eigene Texte überschreiben */
export async function datenLaden(db: Db, jahr: number, eingaben: { titel?: string; untertitel?: string; texte?: Record<string, string> }): Promise<Daten> {
  const v = await vereinLesen(db);
  const h = heute();
  const werte = new Map<string, string>([
    ['verein.name', v.name], ['stand.datum', dat(h)], ['jahr', String(jahr)],
    ['praesentation.titel', eingaben.titel?.trim() || `${v.name} ${jahr}`], ['praesentation.untertitel', eingaben.untertitel?.trim() ?? ''],
  ]);
  const kpis = new Map<string, Kpi & { bereich: string }>();
  for (const k of await alleKpis(db, jahr)) {
    kpis.set(k.key, k);
    werte.set(k.key, k.value); werte.set(`${k.key}.einheit`, k.unit === 'EUR' ? '€' : k.unit); werte.set(`${k.key}.titel`, k.title); werte.set(`${k.key}.text`, k.subtitle);
  }
  const l = await liquiditaet(db, Number(h.slice(0, 4)), Number(h.slice(5, 7)));
  for (const [k, x] of [['geld', l.geld], ['forderung', l.forderung], ['rechnungen', l.rechnungen.summe], ['kredit', l.kredit], ['summe', l.liquiditaet]] as const) werte.set(`liq.${k}`, de(x));
  werte.set('liq.monat', `${String(l.monat).padStart(2, '0')}/${l.jahr}`);
  for (const [k, x] of Object.entries(eingaben.texte ?? {})) werte.set(k, x);
  return { werte, kpis };
}

/** bekannte Platzhalter (für die Anzeige „wird gefüllt / bitte eintragen“) */
export function bekannt(p: string, d: Daten): boolean {
  const m = /^(DIAGRAMM|TABELLE)(?::(.+))?$/.exec(p);
  if (m) return m[1] === 'DIAGRAMM' ? !!DIAGRAMME[m[2] ?? ''] : !!TABELLEN[m[2] ?? ''];
  return d.werte.has(p);
}
