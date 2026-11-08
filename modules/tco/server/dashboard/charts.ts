/**
 * Diagrammdaten der Vereinsübersicht (Port der chart_*-Methoden aus Z2UI5_CL_TCO_REPORTING).
 * Der Server liefert nur Zahlenreihen – gezeichnet wird in der Oberfläche (Chart.tsx).
 */
import type { Db } from '../verein.js';
import { heute, nameSchoen, runden } from '../format.js';

export interface KeyText { key: string; text: string }
/** Linien-/Punktdiagramm: zwei Reihen je Beschriftung */
export interface Point { label: string; val1: number; val2: number }
/** Kombidiagramm: Linie (Bestand) + Balken nach oben (Eintritte) und unten (Austritte, negativ) */
export interface Combo { label: string; val_line: number; bar_pos: number; bar_neg: number }
/** Gruppierte, gestapelte Balken: Gruppe (Monat) → Balken (Jahr) → Segment (Trainer / Buchungsart) */
export interface StackVal { grp: number; bar: string; stack: string; value: number }
export interface Legend { key: string; text: string; kurz?: string; color?: string; hatch?: boolean }
export interface Stacked { groups: string[]; bars: Legend[]; stacks: Legend[]; values: StackVal[]; mainBar: string; title: string; unit: string; emptyText: string }

export const MONATE_KURZ = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
export const HAL_ABO = 'ABO', HAL_EINZEL = 'EINZEL', HAL_EINZEL_PLAN = 'EINZEL_PLAN';
export const JUG_GESAMT = 'GESAMT', JUG_TRAINER = 'TRAINER';

/** Stundenangabe wie conv_hours: ganze Zahl ohne Nachkommastellen, sonst ohne überzählige Nullen (1,50 → 1,5) */
export function stunden(v: number): string {
  const r = runden(v);
  if (Number.isInteger(r)) return r.toLocaleString('de-DE');
  return r.toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 2 });
}

// ---------------------------------------------------------------- Jahresauswahl (jahre_aufbauen, auswahl_bereinigen, jahre_auswahl, hauptjahr, jahre_text)

/** Jahre absteigend (neuestes oben); das Geschäftsjahr ist immer enthalten */
export function jahreAufbauen(von: number | null, bis: number | null, gj: number): KeyText[] {
  const v = Math.min(von ?? gj, gj), b = Math.max(bis ?? gj, gj);
  const out: KeyText[] = [];
  for (let j = b; j >= v; j--) out.push({ key: String(j), text: String(j) });
  return out;
}

/** Nur angebotene Jahre, keine Doppelten; ohne Auswahl gilt das Geschäftsjahr */
export function auswahlBereinigen(jahre: KeyText[], sel: string[], gj: number): string[] {
  const out: string[] = [];
  for (const s of sel) if (jahre.some((j) => j.key === s) && !out.includes(s)) out.push(s);
  return out.length ? out : [String(gj)];
}

/** Ausgewählte Jahre chronologisch sortiert; ohne Auswahl das Geschäftsjahr */
export function jahreAuswahl(sel: string[], gj: number): number[] {
  const out: number[] = [];
  for (const s of sel) { if (!/^\d{4}$/.test(s)) continue; const j = Number(s); if (!out.includes(j)) out.push(j); }
  if (!out.length) out.push(gj);
  return out.sort((a, b) => a - b);
}

/** Hervorgehobener Balken: das Geschäftsjahr, falls ausgewählt – sonst das jüngste Jahr */
export const hauptjahr = (jahre: number[], gj: number) => (jahre.length && !jahre.includes(gj) ? jahre[jahre.length - 1] : gj);

/** Jahre für den Diagrammtitel: 2026 / 2024, 2026 / 2023 - 2026 (lückenlos ab drei Jahren) */
export function jahreText(jahre: number[]): string {
  if (!jahre.length) return '';
  const von = jahre[0], bis = jahre[jahre.length - 1];
  if (jahre.length >= 3 && bis - von + 1 === jahre.length) return `${von} - ${bis}`;
  return jahre.join(', ');
}

// ---------------------------------------------------------------- Mitglieder

export interface MtgStat { jahr: number; eintritt: number; austritt: number; gesamt: number }

/**
 * Port von ZCL_TCO_MITGLIEDER=>MITGLIEDERANZAHL_ERMITTELN (ohne Altersliste):
 * Anzahl = Mitglieder mit Eintritt abzüglich derer mit Austritt; Statistik je Jahr (Ein-/Austritte, Saldo).
 */
export async function mitgliederStat(db: Db): Promise<{ anzahl: number; stat: MtgStat[] }> {
  const rows = await db`select eintritt::text as eintritt, austritt::text as austritt from tco.mitglieder`;
  const stat = new Map<number, MtgStat>();
  const je = (j: number) => { let s = stat.get(j); if (!s) { s = { jahr: j, eintritt: 0, austritt: 0, gesamt: 0 }; stat.set(j, s); } return s; };
  let anzahl = 0;
  for (const r of rows) {
    if (!r.eintritt) continue;                      // ohne Eintritt (mit oder ohne Austritt) zählt nicht
    anzahl++;
    const e = je(Number(r.eintritt.slice(0, 4))); e.eintritt++; e.gesamt++;
    if (r.austritt) {
      const a = je(Number(r.austritt.slice(0, 4))); a.austritt++; a.gesamt--;
      anzahl--;
    }
  }
  return { anzahl, stat: [...stat.values()].sort((a, b) => a.jahr - b.jahr) };
}

/** Mitgliederentwicklung im Geschäftsjahr je Monat: Bestand (Linie), Eintritte, Austritte */
export async function chartMtgMonate(db: Db, jahr: number): Promise<Combo[]> {
  const von = `${jahr}-01-01`, bis = `${jahr}-12-31`;
  const rows = await db`select eintritt::text as eintritt, austritt::text as austritt from tco.mitglieder`;
  const ein = new Array<number>(12).fill(0), aus = new Array<number>(12).fill(0);
  let bestand = 0;
  for (const m of rows) {
    if (m.eintritt && m.eintritt < von && (!m.austritt || m.austritt >= von)) bestand++;
    if (m.eintritt && m.eintritt >= von && m.eintritt <= bis) ein[Number(m.eintritt.slice(5, 7)) - 1]++;
    if (m.austritt && m.austritt >= von && m.austritt <= bis) aus[Number(m.austritt.slice(5, 7)) - 1]++;
  }
  const out: Combo[] = [];
  for (let i = 0; i < 12; i++) {
    bestand += ein[i] - aus[i];
    out.push({ label: String(i + 1).padStart(2, '0'), val_line: bestand, bar_pos: ein[i], bar_neg: -aus[i] });
  }
  return out;
}

/** Mitgliederentwicklung der letzten zehn Jahre: Bestand zum Jahresende, Eintritte, Austritte */
export async function chartMtgJahre(db: Db): Promise<Combo[]> {
  const { stat } = await mitgliederStat(db);
  const bis = Number(heute().slice(0, 4)), von = bis - 9;
  // Startbestand: alles, was vor dem Anzeigefenster passiert ist
  let bestand = stat.filter((s) => s.jahr < von).reduce((a, s) => a + s.gesamt, 0);
  const out: Combo[] = [];
  for (let j = von; j <= bis; j++) {
    const s = stat.find((x) => x.jahr === j);
    bestand += s?.gesamt ?? 0;
    out.push({ label: String(j), val_line: bestand, bar_pos: s?.eintritt ?? 0, bar_neg: -(s?.austritt ?? 0) });
  }
  return out;
}

// ---------------------------------------------------------------- Clubhaus

/** Clubheimerträge je Monat: Umsatz VK brutto und Rohertrag (VK - EK - Reinigung - Provision) */
export async function chartClubhaus(db: Db, jahr: number): Promise<Point[]> {
  const mon = await db`select monat, coalesce(sum(vkbrutto), 0)::float8 as vkbrutto, coalesce(sum(ekbrutto), 0)::float8 as ekbrutto,
                              coalesce(sum(reinigung), 0)::float8 as reinigung, coalesce(sum(provision), 0)::float8 as provision
                         from tco.forderungen where jahr = ${jahr} group by monat order by monat`;
  const out: Point[] = [];
  for (let m = 1; m <= 12; m++) {
    const r = mon.find((x) => Number(x.monat) === m);
    out.push({ label: String(m).padStart(2, '0'), val1: r ? runden(r.vkbrutto) : 0, val2: r ? runden(r.vkbrutto - r.ekbrutto - r.reinigung - r.provision) : 0 });
  }
  return out;
}

// ---------------------------------------------------------------- Jugend

export interface JugStd { jahr: number; monat: number; trainer: string; stunden: number }

/** Stundenrückmeldungen der Trainer (alle Trainingsarten) je Jahr, Monat und Trainer */
export async function jugendStundenLesen(db: Db, von: string, bis: string): Promise<JugStd[]> {
  const rows = await db`select upper(trim(regexp_replace(coalesce(zalias, ''), '\\s+', ' ', 'g'))) as trainer,
                               extract(year from datum)::int as jahr, extract(month from datum)::int as monat,
                               coalesce(sum(anzahl), 0)::float8 as stunden
                          from tco.jrueckm where datum between ${von} and ${bis} group by 1, 2, 3 order by 2, 3, 1`;
  return rows.map((r) => ({ jahr: r.jahr, monat: r.monat, trainer: r.trainer || 'OHNE ZUORDNUNG', stunden: runden(r.stunden) }));
}

const PALETTE = ['#5899DA', '#E8743B', '#19A979', '#ED4A7B', '#945ECF', '#13A4B4', '#525DF4', '#BF399E', '#6C8893', '#EE6868', '#2F6497'];

/** Trainingsstunden Jugend je Monat: Balken je Jahr, Segmente je Trainer bzw. ein Segment „gesamt“ */
export async function chartJugend(db: Db, jahre: number[], gj: number, ansicht: string): Promise<Stacked> {
  const main = hauptjahr(jahre, gj);
  const gesamt = ansicht === JUG_GESAMT;
  const std = await jugendStundenLesen(db, `${jahre[0]}-01-01`, `${jahre[jahre.length - 1]}-12-31`);
  const values: StackVal[] = [];
  const trainer = new Map<string, { total: number; main: number }>();
  for (const s of std) {
    if (!jahre.includes(s.jahr)) continue;
    const stack = gesamt ? JUG_GESAMT : s.trainer;
    let v = values.find((x) => x.grp === s.monat && x.bar === String(s.jahr) && x.stack === stack);
    if (!v) { v = { grp: s.monat, bar: String(s.jahr), stack, value: 0 }; values.push(v); }
    v.value = runden(v.value + s.stunden);
    let t = trainer.get(stack);
    if (!t) { t = { total: 0, main: 0 }; trainer.set(stack, t); }
    t.total += s.stunden;
    if (s.jahr === main) t.main += s.stunden;
  }
  const bars: Legend[] = jahre.map((j) => {
    const sum = std.filter((s) => s.jahr === j).reduce((a, s) => a + s.stunden, 0);
    return { key: String(j), text: `${j}: ${stunden(sum)} Std`, kurz: `'${String(j).slice(2)}` };
  });
  const mj = jahre.length > 1 ? ` ${main}` : '';
  let stacks: Legend[] = [];
  if (gesamt) {
    const g = trainer.get(JUG_GESAMT);
    if (g) stacks = [{ key: JUG_GESAMT, text: `Trainingsstunden gesamt (${stunden(g.main)} Std${mj})`, color: PALETTE[0] }];
  } else {
    // nach Stunden im hervorgehobenen Jahr absteigend – so bleibt die Farbe je Trainer stabil
    const sorted = [...trainer].sort((a, b) => b[1].main - a[1].main || b[1].total - a[1].total || a[0].localeCompare(b[0]));
    stacks = sorted.map(([k, t], i) => ({ key: k, text: `${nameSchoen(k)} (${stunden(t.main)} Std${mj})`, color: PALETTE[i % PALETTE.length] }));
  }
  const jt = jahreText(jahre);
  return {
    groups: MONATE_KURZ, bars, stacks, values, mainBar: String(main), unit: 'Std',
    title: gesamt ? `Trainingsstunden Jugend ${jt} je Monat` : `Trainingsstunden Jugend ${jt} je Monat und Trainer`,
    emptyText: 'Keine Stundenrückmeldungen der Trainer im gewählten Zeitraum',
  };
}

// ---------------------------------------------------------------- Halle

export interface HalStd { jahr: number; monat: number; art: string; stunden: number }

/**
 * Hallenbuchungen (EP3) je Jahr, Monat und Buchungsart in Stunden.
 * Einzelbuchung: Status 1, Status 5 sowie Abos, die über bookings_ch zur Einzelabrechnung gekennzeichnet sind
 * (status_abw = 1). Abo: alle übrigen Buchungen mit Status 3. Storniert (2) / entfallen (4) zählen nicht.
 * Einzelbuchungen nach dem heutigen Tag werden gesondert (zukünftig) ausgewiesen.
 */
export async function halleStundenLesen(db: Db, von: string, bis: string): Promise<HalStd[]> {
  const h = heute();
  const rows = await db`select extract(year from b.datum)::int as jahr, extract(month from b.datum)::int as monat,
                               case when b.status = '3' and coalesce(c.status_abw, '') <> '1' then ${HAL_ABO}
                                    when b.datum > ${h}::date then ${HAL_EINZEL_PLAN} else ${HAL_EINZEL} end as art,
                               sum(case when s.sek > 0 then s.sek else 0 end)::float8 / 3600 as stunden
                          from tco.bookings b
                          left join tco.bookings_ch c on c.bid = b.bid
                          cross join lateral (select case when extract(epoch from (b.time_ende - b.time_start)) < 0
                                                          then extract(epoch from (b.time_ende - b.time_start)) + 86400
                                                          else extract(epoch from (b.time_ende - b.time_start)) end as sek) s
                         where b.datum between ${von} and ${bis} and b.status in ('1', '3', '5')
                           and b.time_start is not null and b.time_ende is not null
                         group by 1, 2, 3 order by 1, 2, 3`;
  return rows.filter((r) => Number(r.stunden) > 0).map((r) => ({ jahr: r.jahr, monat: r.monat, art: r.art, stunden: runden(Number(r.stunden)) }));
}

/** Hallenbuchungen je Monat: Balken je Jahr, Segmente Abo / Einzelbuchung / Einzelbuchung zukünftig */
export async function chartHalle(db: Db, jahre: number[], gj: number): Promise<Stacked> {
  const main = hauptjahr(jahre, gj);
  const std = await halleStundenLesen(db, `${jahre[0]}-01-01`, `${jahre[jahre.length - 1]}-12-31`);
  const values: StackVal[] = std.filter((s) => jahre.includes(s.jahr)).map((s) => ({ grp: s.monat, bar: String(s.jahr), stack: s.art, value: s.stunden }));
  const bars: Legend[] = jahre.map((j) => {
    const sum = std.filter((s) => s.jahr === j).reduce((a, s) => a + s.stunden, 0);
    return { key: String(j), text: `${j}: ${stunden(sum)} Std`, kurz: `'${String(j).slice(2)}` };
  });
  const arten: Legend[] = [
    { key: HAL_ABO, text: 'Abo', color: '#5899DA' },
    { key: HAL_EINZEL, text: 'Einzelbuchung', color: '#E8743B' },
    { key: HAL_EINZEL_PLAN, text: 'Einzelbuchung zukünftig', color: '#E8743B', hatch: true },
  ];
  const mj = jahre.length > 1 ? ` ${main}` : '';
  const stacks: Legend[] = [];
  for (const a of arten) {
    let sum = 0, m = 0;
    for (const v of values) if (v.stack === a.key) { sum += v.value; if (v.bar === String(main)) m += v.value; }
    if (sum === 0) continue;                        // Buchungsarten ohne Stunden nicht in der Legende führen
    stacks.push({ ...a, text: `${a.text} (${stunden(m)} Std${mj})` });
  }
  return {
    groups: MONATE_KURZ, bars, stacks, values, mainBar: String(main), unit: 'Std',
    title: `Hallenbuchungen ${jahreText(jahre)} je Monat: Abo und Einzelbuchungen`,
    emptyText: 'Keine Hallenbuchungen im gewählten Zeitraum',
  };
}

/** Gesamtstunden je Kalenderjahr (Abo + Einzelbuchungen, inkl. gebuchter künftiger Termine) für fünf Jahre */
export async function chartHalleJahre(db: Db): Promise<Point[]> {
  const bis = Number(heute().slice(0, 4)), von = bis - 4;
  const std = await halleStundenLesen(db, `${von}-01-01`, `${bis}-12-31`);
  const out: Point[] = [];
  for (let j = von; j <= bis; j++) out.push({ label: String(j), val1: runden(std.filter((s) => s.jahr === j).reduce((a, s) => a + s.stunden, 0)), val2: 0 });
  return out;
}

/** Jahre mit Daten (von/bis) für die Mehrfachauswahl der Diagramme Jugend, Halle und Finanzen */
export async function datenJahre(db: Db): Promise<{ jugend: [number | null, number | null]; halle: [number | null, number | null]; fin: [number | null, number | null] }> {
  const [j] = await db`select extract(year from min(datum))::int as von, extract(year from max(datum))::int as bis from tco.jrueckm where datum >= '2000-01-01'`;
  const [h] = await db`select extract(year from min(datum))::int as von, extract(year from max(datum))::int as bis from tco.bookings where datum >= '2000-01-01' and status in ('1', '3', '5')`;
  const [f] = await db`select min(jahr)::int as von, max(jahr)::int as bis from tco.fibuchungen`;
  return { jugend: [j?.von ?? null, j?.bis ?? null], halle: [h?.von ?? null, h?.bis ?? null], fin: [f?.von ?? null, f?.bis ?? null] };
}
