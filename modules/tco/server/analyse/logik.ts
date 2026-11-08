import { BusinessError } from '../../../../server/src/errors.js';
import { heute, runden } from '../format.js';
import type { Db } from '../verein.js';
import { leer, ZAHLUNGSARTEN, ZAHLUNGSWEISEN } from '../mitglieder/logik.js';

/**
 * Mitglieder-Analyse – Port von Z2UI5_CL_TCO_MITGL_ANALYTIC.
 *
 * Gearbeitet wird auf EINHEITEN: ein Mitglied zusammen mit EINEM sichtbaren Vertrag;
 * ein Mitglied ohne Vertrag ist eine Einheit ohne Vertragsdaten. Dadurch greift die
 * Gruppierung sowohl auf Mitglieds- (Ort, Status …) als auch auf Vertragsebene
 * (Vertragsart). Je Gruppe werden die VERSCHIEDENEN Mitglieder gezählt und die
 * Beiträge der sichtbaren Verträge summiert.
 */

export const REPID = 'MITGL_ANALYTIC';

export const GRUPPEN: [string, string][] = [
  ['', 'Keine Gruppierung'], ['MITGLIED', 'Mitglied'], ['VERTRAGSART', 'Vertragsart'], ['ORT', 'Ort'], ['GESCHLECHT', 'Geschlecht'],
  ['ALTER', 'Altersgruppe'], ['EINTRITT', 'Eintrittsjahr'], ['ZAHLART', 'Zahlungsart'], ['STATUS', 'Status'],
];
export const SORTIERUNGEN: [string, string][] = [
  ['NACHNAME', 'Nachname, Vorname'], ['MITGLNR', 'Mitgliedsnummer'], ['EINTRITT', 'Eintrittsdatum'], ['ALTER', 'Lebensalter'],
  ['JAHRE', 'Mitgliedsjahre'], ['ORT', 'Ort'], ['BETRAG', 'Beitragsvolumen'],
];
export const ALTERSGRUPPEN = ['bis 18 Jahre', '19 bis 26 Jahre', '27 bis 40 Jahre', '41 bis 60 Jahre', 'über 60 Jahre', 'ohne Geburtsdatum'];
export const GESCHLECHTER = ['männlich', 'weiblich', 'ohne Angabe'];

/** Spalten wie COL_INIT (Reihenfolge, Beschriftung, Ausrichtung, Standard-Sichtbarkeit) */
export interface Spalte { field: string; label: string; width: number; halign: 'Begin' | 'End'; visible: boolean }
export const SPALTEN: Spalte[] = [
  { field: 'gruppe', label: 'Gruppe / Summe', width: 200, halign: 'Begin', visible: true },
  { field: 'nachname', label: 'Nachname', width: 150, halign: 'Begin', visible: true },
  { field: 'vorname', label: 'Vorname', width: 130, halign: 'Begin', visible: true },
  { field: 'mitglnr', label: 'Mitgl.-Nr.', width: 100, halign: 'Begin', visible: true },
  { field: 'anzahl', label: 'Anzahl', width: 80, halign: 'End', visible: true },
  { field: 'lebensalter', label: 'Alter', width: 80, halign: 'End', visible: true },
  { field: 'mitgliedsjahre', label: 'Mitgliedsjahre', width: 120, halign: 'End', visible: true },
  { field: 'altersgruppe', label: 'Altersgruppe', width: 140, halign: 'Begin', visible: true },
  { field: 'geschlecht', label: 'Geschlecht', width: 110, halign: 'Begin', visible: true },
  { field: 'plz', label: 'PLZ', width: 80, halign: 'Begin', visible: false },
  { field: 'ort', label: 'Ort', width: 150, halign: 'Begin', visible: true },
  { field: 'status', label: 'Status', width: 120, halign: 'Begin', visible: true },
  { field: 'eintritt', label: 'Eintritt', width: 105, halign: 'Begin', visible: true },
  { field: 'austritt', label: 'Austritt', width: 105, halign: 'Begin', visible: false },
  { field: 'zahlungsart', label: 'Zahlungsart', width: 120, halign: 'Begin', visible: false },
  { field: 'zahlweise', label: 'Zahlungsweise', width: 130, halign: 'Begin', visible: false },
  { field: 'vertraege_anzahl', label: 'Anz. Verträge', width: 110, halign: 'End', visible: false },
  { field: 'vertraege_aktiv', label: 'Aktive Verträge', width: 120, halign: 'End', visible: false },
  { field: 'vertraege_betrag', label: 'Beitrag gesamt', width: 130, halign: 'End', visible: true },
  { field: 'vertrag_art', label: 'Vertragsart', width: 190, halign: 'Begin', visible: true },
  { field: 'vertrag_beginn', label: 'Vertragsbeginn', width: 120, halign: 'Begin', visible: true },
  { field: 'vertrag_ende', label: 'Vertragsende', width: 120, halign: 'Begin', visible: true },
  { field: 'vertrag_betrag', label: 'Vertragsbetrag', width: 130, halign: 'End', visible: true },
  { field: 'vertrag_status', label: 'Vertragsstatus', width: 120, halign: 'Begin', visible: false },
];

/** Alle Kriterien wirken UND-verknüpft (TY_FILTER) */
export interface Filter {
  status: '' | 'A' | 'X';
  geschlecht: string; altersgruppe: string; ort: string; plz: string; zahlungsart: string; zahlweise: string;
  eintritt_von: string; eintritt_bis: string; alter_von: string; alter_bis: string;
  vertragsart: string; vertrag_scope: '' | 'A' | 'B'; vertragsbest: '' | 'M' | 'O';
  sort_by: string; sort_desc: boolean;
}

/** Komplette Sicht (Filter, Gruppierung, Details, Suche, sichtbare Spalten) – Inhalt einer Variante */
export interface Sicht { filter: Filter; group_by: string; details: boolean; search: string; cols: string[] }

export const filterStandard = (): Filter => ({
  status: 'A', geschlecht: '', altersgruppe: '', ort: '', plz: '', zahlungsart: '', zahlweise: '', eintritt_von: '', eintritt_bis: '',
  alter_von: '', alter_bis: '', vertragsart: '', vertrag_scope: 'A', vertragsbest: '', sort_by: 'NACHNAME', sort_desc: false,
});
export const sichtStandard = (): Sicht => ({
  filter: filterStandard(), group_by: '', details: true, search: '', cols: SPALTEN.filter((s) => s.visible).map((s) => s.field),
});

// ---------------------------------------------------------------------------
// Datenbasis
// ---------------------------------------------------------------------------

export interface Basis {
  adrnr: string; mitglnr: string; nachname: string; vorname: string; geschlecht: string; plz: string; ort: string; status: string;
  zahlungsart: string; zahlweise: string; eintritt: string | null; austritt: string | null; geburtsdatum: string | null; aktiv: boolean;
  lebensalter: number; mitgliedsjahre: number; altersgruppe: string;
  vertraege_anzahl: number; vertraege_aktiv: number; vertraege_betrag: number;
}
export interface Vertrag { adrnr: string; beginn: string | null; art: string; ende: string | null; betrag: number; aktiv: boolean }
export interface Daten { basis: Basis[]; vertraege: Vertrag[] }

const artNorm = (a: unknown) => leer(a).replace(/^0+(?=\d)/, '');

/** ganze Jahre zwischen zwei Tagen (wie floor( Tage / 365.25 ) in ABAP) */
export function jahre(von: string, bis: string): number {
  const t = (Date.parse(`${bis}T12:00:00Z`) - Date.parse(`${von}T12:00:00Z`)) / 86_400_000;
  return Math.max(0, Math.floor(t / 365.25));
}

export function altersgruppe(geburtsdatum: string | null, alter: number): string {
  if (!geburtsdatum) return 'ohne Geburtsdatum';
  if (alter < 19) return 'bis 18 Jahre';
  if (alter < 27) return '19 bis 26 Jahre';
  if (alter < 41) return '27 bis 40 Jahre';
  if (alter < 61) return '41 bis 60 Jahre';
  return 'über 60 Jahre';
}

/** READ_DATA: Mitglieder mit Eintrittsdatum, alle Verträge mit Betrag laut Beitragsstamm (außer individuell) */
export async function datenLesen(db: Db, stichtag = heute()): Promise<Daten> {
  const m = await db`select adrnr, mitglnrn, nachname, vorname, geschlecht, plz, ort, zahlungsart, zahlungsweise,
                            eintritt::text as eintritt, austritt::text as austritt, geburtsdatum::text as geburtsdatum
                       from tco.mitglieder where eintritt is not null`;
  const v = await db`select adrnr, art, artname, vertragbegin::text as beginn, vertragende::text as ende, coalesce(betrag, 0)::float8 as betrag, betrag_indiv
                       from tco.vertraege`;
  const preise = await db`select art, gueltig_ab::text as ab, gueltig_bis::text as bis, betrag::float8 as betrag from tco.beitrag_pr order by gueltig_ab desc`;
  const preis = (art: string, d: string) => preise.find((p) => artNorm(p.art) === artNorm(art) && p.ab <= d && (!p.bis || p.bis >= d));

  const vertraege: Vertrag[] = v.map((x) => {
    const ende = x.ende as string | null;
    // Betrag laut Beitragsstamm (heute bzw. zum Vertragsende), außer individuell
    const datum = ende && ende < stichtag ? ende : stichtag;
    const betrag = x.betrag_indiv ? Number(x.betrag) : preis(x.art, datum)?.betrag ?? Number(x.betrag);
    return { adrnr: x.adrnr, beginn: x.beginn, art: leer(x.artname), ende, betrag: runden(Number(betrag) || 0), aktiv: !ende || ende >= stichtag };
  }).sort((a, b) => a.adrnr.localeCompare(b.adrnr) || (a.beginn ?? '').localeCompare(b.beginn ?? '') || a.art.localeCompare(b.art, 'de'));

  const basis: Basis[] = m.map((x) => {
    const aktiv = !x.austritt || x.austritt > stichtag;
    const alter = x.geburtsdatum ? jahre(x.geburtsdatum, stichtag) : 0;
    const g = leer(x.geschlecht);
    return {
      adrnr: x.adrnr, mitglnr: leer(x.mitglnrn).replace(/^0+(?=\d)/, ''), nachname: leer(x.nachname), vorname: leer(x.vorname),
      geschlecht: g === '1' ? 'männlich' : g === '2' ? 'weiblich' : 'ohne Angabe', plz: leer(x.plz), ort: leer(x.ort),
      status: aktiv ? 'aktiv' : 'ausgetreten',
      zahlungsart: ZAHLUNGSARTEN[leer(x.zahlungsart)] ?? leer(x.zahlungsart),
      zahlweise: ZAHLUNGSWEISEN[leer(x.zahlungsweise)] ?? leer(x.zahlungsweise),
      eintritt: x.eintritt, austritt: x.austritt, geburtsdatum: x.geburtsdatum, aktiv,
      lebensalter: alter, mitgliedsjahre: x.eintritt ? jahre(x.eintritt, aktiv ? stichtag : x.austritt!) : 0,
      altersgruppe: altersgruppe(x.geburtsdatum, alter),
      vertraege_anzahl: 0, vertraege_aktiv: 0, vertraege_betrag: 0,
    };
  });
  return { basis, vertraege };
}

/** Wertehilfen aus den gelesenen Daten (Ort, Zahlungsart, Zahlungsweise, Vertragsart) */
export function wertehilfen(d: Daten) {
  const u = (l: string[]) => [...new Set(l.filter(Boolean))].sort((a, b) => a.localeCompare(b, 'de'));
  return {
    orte: u(d.basis.map((b) => b.ort)), zahlungsarten: u(d.basis.map((b) => b.zahlungsart)),
    zahlweisen: u(d.basis.map((b) => b.zahlweise)), vertragsarten: u(d.vertraege.map((v) => v.art)),
    altersgruppen: ALTERSGRUPPEN, geschlechter: GESCHLECHTER,
  };
}

// ---------------------------------------------------------------------------
// Auswertung (BUILD_ROWS)
// ---------------------------------------------------------------------------

/** ROWTYPE: D Detailzeile (Mitglied mit erstem Vertrag), V Folgevertrag, G Gruppenkopf, T Gesamtsumme */
export interface Zeile {
  rowtype: 'D' | 'V' | 'G' | 'T'; highlight: 'None' | 'Information' | 'Critical' | 'Positive'; adrnr: string;
  gruppe: string; mitglnr: string; nachname: string; vorname: string; geschlecht: string; plz: string; ort: string; status: string;
  zahlungsart: string; zahlweise: string; eintritt: string; austritt: string; altersgruppe: string; lebensalter: string; mitgliedsjahre: string;
  anzahl: string; vertraege_anzahl: string; vertraege_aktiv: string; vertraege_betrag: string;
  vertrag_art: string; vertrag_beginn: string; vertrag_ende: string; vertrag_betrag: string; vertrag_status: string;
}

export interface Kpi { mitglieder: number; aktiv: number; alter: number | null; jahre: number | null; betrag: number; vertraege: number }
export interface Diagramme {
  alter: { label: string; wert: number }[];
  geschlecht: { label: string; wert: number }[];
  jahre: { jahr: number; eintritte: number; austritte: number }[];
  vertragsarten: { label: string; anzahl: number; betrag: number }[];
  orte: { label: string; wert: number }[];
}
export interface Ergebnis { rows: Zeile[]; kpi: Kpi; diagramme: Diagramme; filterCount: number; titel: string }

const dat = (iso: string | null) => (iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : '');
const betragOut = (b: number) => (b ? `${b.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} EUR` : '');
const schnitt = (sum: number, cnt: number) => (cnt > 0 ? Math.round(sum / cnt) : null);
const pad = (n: number, w: number) => String(Math.max(0, Math.trunc(n))).padStart(w, '0');

export function filterCount(f: Filter): number {
  return (['status', 'geschlecht', 'altersgruppe', 'ort', 'plz', 'zahlungsart', 'zahlweise', 'eintritt_von', 'eintritt_bis', 'alter_von', 'alter_bis',
    'vertragsart', 'vertrag_scope', 'vertragsbest'] as const).filter((k) => !!f[k]).length;
}

/** Passt der Vertrag zu den vertragsbezogenen Filtern? (VERTRAG_OK) */
function vertragOk(f: Filter, v: Vertrag): boolean {
  if (f.vertragsart && v.art !== f.vertragsart) return false;
  if (f.vertrag_scope === 'A' && !v.aktiv) return false;
  if (f.vertrag_scope === 'B' && v.aktiv) return false;
  return true;
}

/** Normierter Sortierwert des Mitglieds (SORT_VALUE) */
function sortValue(f: Filter, b: Basis): string {
  switch (f.sort_by) {
    case 'MITGLNR': return pad(Number(b.mitglnr) || 0, 12);
    case 'EINTRITT': return b.eintritt ?? '';
    case 'ALTER': return pad(b.lebensalter, 5);
    case 'JAHRE': return pad(b.mitgliedsjahre, 5);
    case 'ORT': return b.ort;
    case 'BETRAG': return pad(Math.round(b.vertraege_betrag * 100), 16);
    default: return `${b.nachname}#${b.vorname}`;
  }
}

function groupKey(groupBy: string, b: Basis, v: Vertrag | null): string {
  switch (groupBy) {
    case 'MITGLIED': return `${b.nachname}, ${b.vorname} (${b.mitglnr})`;
    case 'VERTRAGSART': return !v || !v.art ? 'ohne Vertrag' : v.art;
    case 'ORT': return b.ort || 'ohne Ort';
    case 'GESCHLECHT': return b.geschlecht;
    case 'ALTER': return b.altersgruppe;
    case 'EINTRITT': return b.eintritt ? `Eintritt ${b.eintritt.slice(0, 4)}` : 'ohne Eintrittsdatum';
    case 'ZAHLART': return b.zahlungsart || 'ohne Zahlungsart';
    case 'STATUS': return b.status;
    default: return '';
  }
}

interface Agg { cnt_mem: number; cnt_v: number; sum_alter: number; cnt_alter: number; sum_jahre: number; cnt_jahre: number; sum_betr: number }
const aggNeu = (): Agg => ({ cnt_mem: 0, cnt_v: 0, sum_alter: 0, cnt_alter: 0, sum_jahre: 0, cnt_jahre: 0, sum_betr: 0 });
const cmp = (a: string, b: string) => a.localeCompare(b, 'de');

/** 1. Mitglieder selektieren – liefert die gefilterten Mitglieder mit Vertragskennzahlen (LT_WORK) */
export function selektieren(d: Daten, s: Sicht): { work: Basis[]; sichtbar: Map<string, Vertrag[]> } {
  const f = s.filter;
  const such = s.search.trim().toUpperCase();
  const von = Number(f.alter_von), bis = Number(f.alter_bis);
  const byAdr = new Map<string, Vertrag[]>();
  for (const v of d.vertraege) { if (!vertragOk(f, v)) continue; const l = byAdr.get(v.adrnr) ?? []; l.push(v); byAdr.set(v.adrnr, l); }
  const work: Basis[] = [];
  for (const b0 of d.basis) {
    if (f.status === 'A' && !b0.aktiv) continue;
    if (f.status === 'X' && b0.aktiv) continue;
    if (such && ![b0.nachname, b0.vorname, b0.ort, b0.mitglnr].some((t) => t.toUpperCase().includes(such))) continue;
    if (f.geschlecht && b0.geschlecht !== f.geschlecht) continue;
    if (f.altersgruppe && b0.altersgruppe !== f.altersgruppe) continue;
    if (f.ort && b0.ort !== f.ort) continue;
    if (f.plz && !b0.plz.includes(f.plz)) continue;
    if (f.zahlungsart && b0.zahlungsart !== f.zahlungsart) continue;
    if (f.zahlweise && b0.zahlweise !== f.zahlweise) continue;
    if (f.eintritt_von && (!b0.eintritt || b0.eintritt.slice(0, 4) < f.eintritt_von)) continue;
    if (f.eintritt_bis && (!b0.eintritt || b0.eintritt.slice(0, 4) > f.eintritt_bis)) continue;
    if (/^\d+$/.test(f.alter_von) && b0.lebensalter < von) continue;
    if (/^\d+$/.test(f.alter_bis) && b0.lebensalter > bis) continue;
    const vs = byAdr.get(b0.adrnr) ?? [];
    if (f.vertragsart && !vs.length) continue;
    if (f.vertragsbest === 'M' && !vs.length) continue;
    if (f.vertragsbest === 'O' && vs.length) continue;
    work.push({ ...b0, vertraege_anzahl: vs.length, vertraege_aktiv: vs.filter((v) => v.aktiv).length, vertraege_betrag: runden(vs.reduce((x, v) => x + v.betrag, 0)) });
  }
  return { work, sichtbar: byAdr };
}

/** Serverseitige Aggregation: Gruppenköpfe, Detail-/Folgezeilen, Gesamtsumme, Kennzahlen und Diagrammdaten */
export function auswerten(d: Daten, s: Sicht): Ergebnis {
  const f = s.filter;
  const { work, sichtbar } = selektieren(d, s);

  // 2. Einheiten bilden
  interface Unit { grpkey: string; sortval: string; memkey: string; vsort: string; b: Basis; v: Vertrag | null }
  const units: Unit[] = [];
  for (const b of work) {
    const memkey = `${b.nachname}#${b.vorname}#${b.adrnr}`;
    const sortval = sortValue(f, b);
    const vs = sichtbar.get(b.adrnr) ?? [];
    if (!vs.length) { units.push({ grpkey: groupKey(s.group_by, b, null), sortval, memkey, vsort: '', b, v: null }); continue; }
    for (const v of vs) units.push({ grpkey: groupKey(s.group_by, b, v), sortval, memkey, vsort: `${v.beginn ?? ''}${v.art}`, b, v });
  }

  // 3. Sortierung – bei Gruppierung nach Mitglied ist der Schlüssel bereits das Mitglied
  const dir = f.sort_desc ? -1 : 1;
  units.sort((a, b) => (s.group_by && s.group_by !== 'MITGLIED' ? cmp(a.grpkey, b.grpkey) : 0)
    || dir * cmp(a.sortval, b.sortval) || cmp(a.memkey, b.memkey) || cmp(a.vsort, b.vsort));

  // 4. Aggregate je Gruppe und gesamt
  const agg = new Map<string, Agg>();
  const tot = aggNeu();
  const seen = new Set<string>();
  const seenT = new Set<string>();
  let aktiv = 0;
  for (const u of units) {
    let a = agg.get(u.grpkey);
    if (!a) { a = aggNeu(); agg.set(u.grpkey, a); }
    if (u.v) { a.cnt_v++; tot.cnt_v++; a.sum_betr += u.v.betrag; tot.sum_betr += u.v.betrag; }
    if (!seen.has(`${u.grpkey}|${u.b.adrnr}`)) {
      seen.add(`${u.grpkey}|${u.b.adrnr}`);
      a.cnt_mem++;
      if (u.b.lebensalter > 0) { a.sum_alter += u.b.lebensalter; a.cnt_alter++; }
      if (u.b.mitgliedsjahre > 0) { a.sum_jahre += u.b.mitgliedsjahre; a.cnt_jahre++; }
    }
    if (!seenT.has(u.b.adrnr)) {
      seenT.add(u.b.adrnr);
      tot.cnt_mem++;
      if (u.b.aktiv) aktiv++;
      if (u.b.lebensalter > 0) { tot.sum_alter += u.b.lebensalter; tot.cnt_alter++; }
      if (u.b.mitgliedsjahre > 0) { tot.sum_jahre += u.b.mitgliedsjahre; tot.cnt_jahre++; }
    }
  }

  // 5. Zeilenaufbau
  const leerZeile = (): Zeile => ({
    rowtype: 'D', highlight: 'None', adrnr: '', gruppe: '', mitglnr: '', nachname: '', vorname: '', geschlecht: '', plz: '', ort: '', status: '',
    zahlungsart: '', zahlweise: '', eintritt: '', austritt: '', altersgruppe: '', lebensalter: '', mitgliedsjahre: '', anzahl: '',
    vertraege_anzahl: '', vertraege_aktiv: '', vertraege_betrag: '', vertrag_art: '', vertrag_beginn: '', vertrag_ende: '', vertrag_betrag: '', vertrag_status: '',
  });
  const summe = (typ: 'G' | 'T', gruppe: string, a: Agg): Zeile => ({
    ...leerZeile(), rowtype: typ, highlight: 'Positive', gruppe, anzahl: String(a.cnt_mem), vertraege_anzahl: String(a.cnt_v),
    lebensalter: a.cnt_alter ? String(schnitt(a.sum_alter, a.cnt_alter)) : '', mitgliedsjahre: a.cnt_jahre ? String(schnitt(a.sum_jahre, a.cnt_jahre)) : '',
    vertraege_betrag: betragOut(runden(a.sum_betr)),
  });
  const rows: Zeile[] = [];
  let grp: string | null = null, mem = '', toggle = false;
  for (const u of units) {
    if (s.group_by && (grp === null || u.grpkey !== grp)) {
      grp = u.grpkey; mem = '';
      rows.push(summe('G', grp, agg.get(grp)!));
    }
    if (!s.details && s.group_by) continue;
    const neu = u.memkey !== mem;
    if (neu) { mem = u.memkey; toggle = !toggle; }
    const z = leerZeile();
    z.rowtype = neu ? 'D' : 'V';
    z.adrnr = u.b.adrnr;
    z.highlight = !u.b.aktiv ? 'Critical' : toggle ? 'Information' : 'None';
    if (neu) {
      Object.assign(z, {
        mitglnr: u.b.mitglnr, nachname: u.b.nachname, vorname: u.b.vorname, geschlecht: u.b.geschlecht, plz: u.b.plz, ort: u.b.ort, status: u.b.status,
        zahlungsart: u.b.zahlungsart, zahlweise: u.b.zahlweise, eintritt: dat(u.b.eintritt), austritt: dat(u.b.austritt), altersgruppe: u.b.altersgruppe,
        lebensalter: String(u.b.lebensalter), mitgliedsjahre: String(u.b.mitgliedsjahre), anzahl: '1', vertraege_anzahl: String(u.b.vertraege_anzahl),
        vertraege_aktiv: String(u.b.vertraege_aktiv), vertraege_betrag: betragOut(u.b.vertraege_betrag),
      });
    }
    if (u.v) {
      z.vertrag_art = u.v.art; z.vertrag_beginn = dat(u.v.beginn); z.vertrag_ende = u.v.ende ? dat(u.v.ende) : 'laufend';
      z.vertrag_betrag = betragOut(u.v.betrag); z.vertrag_status = u.v.aktiv ? 'aktiv' : 'beendet';
    }
    rows.push(z);
  }
  // 6. Gesamtsumme als letzte Zeile
  rows.push(summe('T', 'Gesamt', tot));

  const kpi: Kpi = {
    mitglieder: tot.cnt_mem, aktiv, alter: schnitt(tot.sum_alter, tot.cnt_alter), jahre: schnitt(tot.sum_jahre, tot.cnt_jahre),
    betrag: runden(tot.sum_betr), vertraege: tot.cnt_v,
  };
  return { rows, kpi, diagramme: diagramme(work, sichtbar), filterCount: filterCount(f), titel: `Mitglieder-Analyse (${tot.cnt_mem})` };
}

/** Diagrammdaten aus den gefilterten Mitgliedern und ihren sichtbaren Verträgen */
export function diagramme(work: Basis[], sichtbar: Map<string, Vertrag[]>): Diagramme {
  const zaehl = (l: string[]) => { const m = new Map<string, number>(); for (const k of l) m.set(k, (m.get(k) ?? 0) + 1); return m; };
  const ag = zaehl(work.map((b) => b.altersgruppe));
  const ge = zaehl(work.map((b) => b.geschlecht));
  const jahre = new Map<number, { eintritte: number; austritte: number }>();
  const j = (y: number) => { let x = jahre.get(y); if (!x) { x = { eintritte: 0, austritte: 0 }; jahre.set(y, x); } return x; };
  for (const b of work) {
    if (b.eintritt) j(Number(b.eintritt.slice(0, 4))).eintritte++;
    if (b.austritt && !b.aktiv) j(Number(b.austritt.slice(0, 4))).austritte++;
  }
  const va = new Map<string, { anzahl: number; betrag: number }>();
  for (const b of work) for (const v of sichtbar.get(b.adrnr) ?? []) {
    const k = v.art || 'ohne Bezeichnung';
    const x = va.get(k) ?? { anzahl: 0, betrag: 0 };
    x.anzahl++; x.betrag = runden(x.betrag + v.betrag); va.set(k, x);
  }
  const orte = [...zaehl(work.map((b) => b.ort || 'ohne Ort'))].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]));
  return {
    alter: ALTERSGRUPPEN.map((label) => ({ label, wert: ag.get(label) ?? 0 })),
    geschlecht: GESCHLECHTER.map((label) => ({ label, wert: ge.get(label) ?? 0 })),
    jahre: [...jahre].sort((a, b) => a[0] - b[0]).map(([jahr, x]) => ({ jahr, ...x })).slice(-15),
    vertragsarten: [...va].map(([label, x]) => ({ label, ...x })).sort((a, b) => b.anzahl - a.anzahl || cmp(a.label, b.label)),
    orte: orte.slice(0, 10).map(([label, wert]) => ({ label, wert })),
  };
}

// ---------------------------------------------------------------------------
// CSV-Export der Trefferliste
// ---------------------------------------------------------------------------

export function csvExport(rows: Zeile[], cols: string[]): string {
  const sp = SPALTEN.filter((s) => cols.includes(s.field));
  const esc = (v: string) => (/[;"\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = [sp.map((s) => esc(s.label)).join(';')];
  for (const r of rows) lines.push(sp.map((s) => esc(String((r as unknown as Record<string, string>)[s.field] ?? ''))).join(';'));
  return `﻿${lines.join('\r\n')}\r\n`;
}

// ---------------------------------------------------------------------------
// Anzeigevarianten (tco.rpt_variant, REPID MITGL_ANALYTIC)
// ---------------------------------------------------------------------------

export interface Variante { key: string; name: string; descr: string; global: boolean; isdef: boolean; text: string }

/** Varianten des Benutzers und globale („*“) */
export async function variantenLesen(db: Db, user: string): Promise<Variante[]> {
  const rows = await db`select uname, variant, descr, isdef from tco.rpt_variant where repid = ${REPID} and (uname = ${user} or uname = '*') order by uname, variant`;
  return rows.map((r) => ({
    key: `${r.uname}/${r.variant}`, name: r.variant, descr: leer(r.descr), global: r.uname === '*', isdef: r.isdef === 'X',
    text: `${r.variant}${r.descr ? ` - ${r.descr}` : ''}${r.uname === '*' ? ' (global)' : ''}`,
  }));
}

/** Inhalt einer Variante lesen; alte SAP-Inhalte (XML) sind nicht lesbar */
export function sichtAusInhalt(content: string | null): Sicht | null {
  if (!content || !content.trim().startsWith('{')) return null;
  try {
    const c = JSON.parse(content) as Partial<Sicht>;
    const std = sichtStandard();
    return {
      filter: { ...std.filter, ...(c.filter ?? {}) }, group_by: c.group_by ?? '', details: c.details ?? true, search: c.search ?? '',
      // nur bekannte Spalten übernehmen – die Spaltendefinition kann sich geändert haben
      cols: Array.isArray(c.cols) ? c.cols.filter((x) => SPALTEN.some((s) => s.field === x)) : std.cols,
    };
  } catch { return null; }
}

export async function varianteLesen(db: Db, user: string, key: string): Promise<{ v: Variante; sicht: Sicht } | null> {
  const [uname, ...rest] = key.split('/');
  const variant = rest.join('/');
  if (uname !== user && uname !== '*') throw new BusinessError('Diese Variante gehört einem anderen Benutzer.');
  const [r] = await db`select * from tco.rpt_variant where repid = ${REPID} and uname = ${uname} and variant = ${variant}`;
  if (!r) return null;
  const sicht = sichtAusInhalt(r.content);
  if (!sicht) throw new BusinessError('Die Variante konnte nicht gelesen werden (Inhalt stammt noch aus SAP oder ist beschädigt).');
  return {
    v: { key, name: r.variant, descr: leer(r.descr), global: uname === '*', isdef: r.isdef === 'X', text: r.variant }, sicht,
  };
}

/** Vorschlagsvariante: erst die eigene, sonst eine global gekennzeichnete */
export async function varianteStandard(db: Db, user: string) {
  const [r] = await db`select uname, variant from tco.rpt_variant where repid = ${REPID} and isdef = 'X' and (uname = ${user} or uname = '*')
                        order by case when uname = ${user} then 0 else 1 end limit 1`;
  if (!r) return null;
  try { return await varianteLesen(db, user, `${r.uname}/${r.variant}`); } catch { return null; }
}

export async function varianteSichern(tx: Db, user: string, v: { name: string; descr: string; global: boolean; isdef: boolean }, sicht: Sicht): Promise<Variante> {
  const name = v.name.trim().toUpperCase();
  if (!name) throw new BusinessError('Bitte einen Namen für die Variante angeben.');
  if (name.length > 30 || /[\/]/.test(name)) throw new BusinessError('Der Variantenname darf höchstens 30 Zeichen lang sein und keinen Schrägstrich enthalten.');
  const uname = v.global ? '*' : user;
  const changed = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  await tx`insert into tco.rpt_variant (repid, uname, variant, descr, isdef, changed, content)
           values (${REPID}, ${uname}, ${name}, ${v.descr.trim()}, ${v.isdef ? 'X' : ''}, ${changed}, ${JSON.stringify(sicht)})
           on conflict (repid, uname, variant) do update set descr = excluded.descr, isdef = excluded.isdef, changed = excluded.changed, content = excluded.content`;
  // eine Vorschlagsvariante je Benutzer – die übrigen zurücknehmen
  if (v.isdef) await tx`update tco.rpt_variant set isdef = '' where repid = ${REPID} and uname = ${uname} and variant <> ${name} and isdef = 'X'`;
  return { key: `${uname}/${name}`, name, descr: v.descr.trim(), global: v.global, isdef: v.isdef, text: name };
}

export async function varianteLoeschen(tx: Db, user: string, key: string): Promise<string> {
  const [uname, ...rest] = key.split('/');
  const variant = rest.join('/');
  if (uname !== user && uname !== '*') throw new BusinessError('Diese Variante gehört einem anderen Benutzer.');
  const r = await tx`delete from tco.rpt_variant where repid = ${REPID} and uname = ${uname} and variant = ${variant}`;
  if (!r.count) throw new BusinessError('Variante nicht gefunden.');
  return variant;
}
