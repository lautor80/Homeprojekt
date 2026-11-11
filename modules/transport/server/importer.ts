import type { Tx } from '../../../server/src/db.js';
import { BusinessError } from '../../../server/src/errors.js';
import { NR_AUFTRAG, NR_RECHNUNG, nummernkreisNachziehen } from './data.js';

/**
 * CSV-Import der SAP-Exporte (ZEU_ARCHIVE / SE16 / Excel), wie IMPORT_* in Z2UI5_CL_EU_AUFTRAG:
 *  - Semikolon-CSV mit Kopfzeile, Spalten werden über die SAP-Feldnamen zugeordnet
 *  - Datei wird am Spaltenkopf erkannt (Dateiname egal)
 *  - nur neue Sätze werden angelegt, vorhandene bleiben unverändert
 *    (Ausnahme: vorhandene, aber leere Adressen werden aus der Datei ergänzt)
 *  - Nummernkreise werden auf die höchste importierte Nummer je Jahr gezogen
 * Zusätzlich zur ABAP-Version: Träger (ZEU_TRAEGER), Produkte (ZEU_PRODUKTE),
 * Wertelisten (DD07T/DD07V der Domänen ZEU_LADEART, ZEU_LADEGUT, ZEU_LADEWEISE, ZEU_PALETTENTAUSCH)
 * und Nummernkreise (ZEU_RGNRKREIS).
 *
 * Modus „ersetzen“ (Neuaufbau, #121): Aufträge, Stops, Träger und Adressen – und Produkte/Wertelisten,
 * wenn ihre Datei dabei ist – werden vorher geleert (TRUNCATE in derselben Transaktion) und komplett aus
 * den Dateien neu angelegt; Nummernkreise werden genau auf den SAP-Stand gesetzt. Verknüpfungen
 * Auftrag ↔ Paperless-Dokument bleiben für Aufträge erhalten, die in der Datei wieder vorkommen.
 * SAP-Tabellen ohne Gegenstück im Portal (ZEU_DOSSIER, ZEU_LADEGUT_T, ZGN_ALV_FIELDS, ZGN_CUST) werden
 * erkannt und als „nicht benötigt“ ausgewiesen.
 */

export type ImportArt = 'AUF' | 'POS' | 'ADR' | 'TRG' | 'PRD' | 'WRT' | 'NRK';
export type ImportModus = 'neu' | 'ersetzen';

/** Für den Neuaufbau nötig: ohne sie würden Aufträge ohne Stops/Träger/Adressen entstehen. */
export const PFLICHT_NEUAUFBAU: ImportArt[] = ['AUF', 'POS', 'ADR', 'TRG'];

export const IMPORT_ARTEN: { key: ImportArt; datei: string; tabelle: string }[] = [
  { key: 'AUF', datei: 'Aufträge.csv', tabelle: 'Aufträge (ZEU_AUFTRAG)' },
  { key: 'POS', datei: 'Aufträge_POs.csv', tabelle: 'Stops (ZEU_AUFTAG_POS)' },
  { key: 'ADR', datei: 'Adressen.csv', tabelle: 'Adressen (ZEU_ADRESSEN)' },
  { key: 'TRG', datei: 'Träger.csv', tabelle: 'Holzträger (ZEU_TRAEGER)' },
  { key: 'PRD', datei: 'Produkte.csv', tabelle: 'Produkte (ZEU_PRODUKTE)' },
  { key: 'WRT', datei: 'Wertelisten.csv', tabelle: 'Wertelisten (DD07T)' },
  { key: 'NRK', datei: 'ZEU_RGNRKREIS.csv', tabelle: 'Nummernkreise (ZEU_RGNRKREIS)' },
];

/** SAP-Tabellen ohne Gegenstück im Portal: werden erkannt, aber nicht übernommen. */
const OHNE_ZIEL: { tabelle: string; passt: (k: Set<string>) => boolean; grund: string }[] = [
  {
    tabelle: 'ZEU_DOSSIER',
    passt: (k) => k.has('RGNR_TXT') && k.has('RGNR_POS') && k.has('KUNDE'),
    grund: 'Altbestand der SAP-Auftragsverwaltung – keine Zieltabelle im Portal',
  },
  {
    tabelle: 'ZEU_LADEGUT_T',
    passt: (k) => k.has('IDENT') && k.has('LADEGUT') && !k.has('RGNR_TXT'),
    grund: 'Ladegut wird im Portal über die Werteliste LADEGUT gepflegt (Stammdaten → Wertelisten)',
  },
  {
    tabelle: 'ZGN_ALV_FIELDS',
    passt: (k) => k.has('REPID') && k.has('FIELDNAME'),
    grund: 'Spaltentexte der SAP-ALV-Listen – im Portal fest hinterlegt',
  },
  {
    tabelle: 'ZGN_CUST',
    passt: (k) => k.has('APPL') && k.has('DRUCKPFAD'),
    grund: 'Druckpfade der SAP GUI – im Portal nicht nötig (Download bzw. Ablage in Paperless)',
  },
];

type Conv = 'text' | 'date' | 'amount' | 'int' | 'bool' | 'adrnr';
interface FeldDef { col: string; conv: Conv }

/** SAP-Feldname → Spalte in der neuen Tabelle */
const MAP: Record<ImportArt, Record<string, FeldDef>> = {
  AUF: {
    RGNR_TXT: { col: 'auftragsnr', conv: 'text' },
    RGANLAGDAT: { col: 'anlagedatum', conv: 'date' },
    KUNDE: { col: 'kunde', conv: 'adrnr' },
    UNTERNEHMER: { col: 'unternehmer', conv: 'adrnr' },
    RE: { col: 'rechnungsempfaenger', conv: 'adrnr' },
    RGBETRAG: { col: 'rgbetrag', conv: 'amount' },
    KENNZEICHEN: { col: 'kennzeichen', conv: 'text' },
    ART: { col: 'fahrzeugtyp', conv: 'text' },
    FRACHTPREIS_EK: { col: 'frachtpreis_ek', conv: 'amount' },
    FRACHTPREIS_VK: { col: 'frachtpreis_vk', conv: 'amount' },
    LADENUMMER: { col: 'ladenummer', conv: 'text' },
    LADEGUT: { col: 'ladegut', conv: 'text' },
    GEWICHT: { col: 'gewicht', conv: 'text' },
    LADEWEISE: { col: 'ladeweise', conv: 'text' },
    PALETTENTAUSCH: { col: 'palettentausch', conv: 'text' },
    ORDERNUMMER: { col: 'ordernummer', conv: 'text' },
    DATUMLADEN1: { col: 'datumladen1', conv: 'date' },
    DATUMENTLADEN1: { col: 'datumentladen1', conv: 'date' },
    BESONDERHEITEN: { col: 'besonderheiten', conv: 'text' },
    FAKTURA: { col: 'faktura', conv: 'text' },
    FAKTURADATUM: { col: 'fakturadatum', conv: 'date' },
    STEUERRELEVANT: { col: 'steuerrelevant', conv: 'bool' },
    DOK_FEHLEN: { col: 'dok_fehlen', conv: 'bool' },
    LEISTUNGSDATUM: { col: 'leistungsdatum', conv: 'date' },
    LADEMETER: { col: 'lademeter', conv: 'amount' },
  },
  POS: {
    RGNR_TXT: { col: 'auftragsnr', conv: 'text' },
    POS: { col: 'pos', conv: 'int' },
    FIRMA: { col: 'firma', conv: 'text' },
    STRASSE: { col: 'strasse', conv: 'text' },
    PLZORT: { col: 'plzort', conv: 'text' },
    LAND: { col: 'land', conv: 'text' },
    LADENUMMER: { col: 'ladenummer', conv: 'text' },
    DATUM: { col: 'datum', conv: 'date' },
    ZEIT: { col: 'zeit', conv: 'text' },
    FIRMA_E: { col: 'firma_e', conv: 'text' },
    STRASSE_E: { col: 'strasse_e', conv: 'text' },
    PLZORT_E: { col: 'plzort_e', conv: 'text' },
    LAND_E: { col: 'land_e', conv: 'text' },
    DATUM_E: { col: 'datum_e', conv: 'date' },
    ZEIT_E: { col: 'zeit_e', conv: 'text' },
  },
  ADR: {
    ADRNR: { col: 'adrnr', conv: 'adrnr' },
    KUNDENNAME: { col: 'kundenname', conv: 'text' },
    KUNDENNAME2: { col: 'kundenname2', conv: 'text' },
    ANREDE: { col: 'anrede', conv: 'text' },
    NAME: { col: 'name', conv: 'text' },
    VORNAME: { col: 'vorname', conv: 'text' },
    STRASSE: { col: 'strasse', conv: 'text' },
    HAUSNUMMER: { col: 'hausnummer', conv: 'text' },
    LAND: { col: 'land', conv: 'text' },
    PLZ: { col: 'plz', conv: 'text' },
    ORT: { col: 'ort', conv: 'text' },
    TELEFON: { col: 'telefon', conv: 'text' },
    FAX: { col: 'fax', conv: 'text' },
    EMAIL: { col: 'email', conv: 'text' },
    GLN: { col: 'gln', conv: 'text' },
    MARKT: { col: 'markt', conv: 'text' },
    USTID: { col: 'ustid', conv: 'text' },
  },
  TRG: {
    RGNR_TXT: { col: 'auftragsnr', conv: 'text' },
    RGNR_POS: { col: 'pos', conv: 'int' },
    PRODUKT: { col: 'produkt', conv: 'text' },
    PROD_TXT: { col: 'prod_txt', conv: 'text' },
    MENGE: { col: 'menge', conv: 'int' },
    PREIS: { col: 'preis', conv: 'amount' },
  },
  PRD: {
    PROD_KEY: { col: 'prod_key', conv: 'text' },
    TEXT: { col: 'text', conv: 'text' },
    PREIS: { col: 'preis', conv: 'amount' },
    VALID_TO: { col: 'gueltig_bis', conv: 'date' },
  },
  NRK: {
    GJAHR: { col: 'jahr', conv: 'int' },
    TYP: { col: 'typ', conv: 'text' },
    NUMMER: { col: 'nummer', conv: 'int' },
  },
  WRT: {
    DOMNAME: { col: 'typ', conv: 'text' },
    DOMVALUE_L: { col: 'schluessel', conv: 'text' },
    DDTEXT: { col: 'text', conv: 'text' },
    VALPOS: { col: 'sort', conv: 'int' },
  },
};

const DOMAENE: Record<string, string> = {
  ZEU_LADEART: 'FAHRZEUGTYP',
  ZEU_LADEGUT: 'LADEGUT',
  ZEU_LADEWEISE: 'LADEWEISE',
  ZEU_PALETTENTAUSCH: 'PALETTENTAUSCH',
};

// ---------------------------------------------------------------------------
// Dekodieren und Parsen
// ---------------------------------------------------------------------------

/** UTF-8 (mit/ohne BOM), sonst Windows-1252 (Exporte aus SAP GUI/Excel) */
export function dekodieren(buf: Buffer): string {
  let b = buf;
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) b = b.subarray(3);
  let s: string;
  try {
    s = new TextDecoder('utf-8', { fatal: true }).decode(b);
  } catch {
    s = new TextDecoder('windows-1252').decode(b);
  }
  return s.replace(/\r\n?/g, '\n');
}

/**
 * Eine CSV-Zeile zerlegen: Felder in "..." dürfen ; enthalten, "" steht für ein
 * Anführungszeichen. "" auch in nicht umschlossenen Feldern (UAB ""NAME"") wird aufgelöst.
 */
export function csvZeile(zeile: string): string[] {
  const teile = zeile.split(';');
  if (!zeile.includes('"')) return teile;
  const out: string[] = [];
  for (let i = 0; i < teile.length; i++) {
    const t = teile[i];
    const auf = t.length - t.replace(/^"+/, '').length;
    if (auf % 2 === 0) {
      out.push(t === '""' ? '' : t.replace(/""/g, '"'));
      continue;
    }
    let feld = t.slice(1);
    let zu = feld.length - feld.replace(/"+$/, '').length;
    while (zu % 2 === 0 && i < teile.length - 1) {
      i++;
      feld = `${feld};${teile[i]}`;
      zu = feld.length - feld.replace(/"+$/, '').length;
    }
    if (zu % 2 === 1) feld = feld.slice(0, -1);
    out.push(feld.replace(/""/g, '"'));
  }
  return out;
}

export function erkennen(kopf: string[]): ImportArt | null {
  const k = new Set(kopf.map((s) => s.trim().toUpperCase()));
  if (k.has('DOMNAME') && k.has('DOMVALUE_L')) return 'WRT';
  if (k.has('GJAHR') && k.has('TYP') && k.has('NUMMER')) return 'NRK';
  if (k.has('PROD_KEY')) return 'PRD';
  if (k.has('ADRNR')) return 'ADR';
  if (k.has('RGNR_TXT') && k.has('RGNR_POS') && k.has('PRODUKT')) return 'TRG';
  if (k.has('RGNR_TXT') && k.has('POS')) return 'POS';
  if (k.has('RGNR_TXT')) return 'AUF';
  return null;
}

function konvertieren(v: string, conv: Conv): unknown {
  const s = v.trim();
  // leeres SAP-Kennzeichen (Leerzeichen) = nein
  if (!s) return conv === 'bool' ? false : undefined;
  switch (conv) {
    case 'text':
      return s;
    case 'bool':
      return ['X', 'TRUE', '1', 'JA', 'J'].includes(s.toUpperCase());
    case 'int': {
      if (!/^-?\d+$/.test(s)) throw new Error('Zahl');
      return Number(s);
    }
    case 'adrnr': {
      if (!/^\d+$/.test(s)) throw new Error('Adressnummer');
      const n = Number(s);
      return n === 0 ? null : n;
    }
    case 'amount': {
      // 1.234,56 | 1234,56 | 1234.56 | 1234.56- (SAP: Minus hinten)
      let t = s.replace(/\s/g, '');
      let neg = false;
      if (t.endsWith('-')) { neg = true; t = t.slice(0, -1); }
      if (t.startsWith('-')) { neg = true; t = t.slice(1); }
      if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
      if (!/^\d+(\.\d+)?$/.test(t)) throw new Error('Betrag');
      return (neg ? -1 : 1) * Number(t);
    }
    case 'date': {
      if (/^0+$/.test(s)) return null;
      let m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
      if (m) return `${m[1]}-${m[2]}-${m[3]}`;
      m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
      if (m) return `${m[1]}-${m[2]}-${m[3]}`;
      m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(s);
      if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
      throw new Error('Datum');
    }
  }
}

/** Typ in ZEU_RGNRKREIS → Nummernkreis im Portal */
const NRK_TYP: Record<string, string> = { A: NR_AUFTRAG, R: NR_RECHNUNG };

export interface OhneZiel {
  ohneZiel: true;
  name: string;
  tabelle: string;
  grund: string;
  anzahl: number;
}

export interface Geparst {
  art: ImportArt;
  name: string;
  zeilen: Record<string, unknown>[];
  alle: number;
  ignoriert: string[];
  unlesbar: number;
}

export function parsen(name: string, csv: string): Geparst | OhneZiel | { fehler: string } {
  const lines = csv.split('\n').filter((l) => l.trim());
  if (!lines.length) return { fehler: `${name}: Die Datei ist leer oder nicht lesbar.` };
  const kopf = csvZeile(lines[0]).map((s) => s.trim().toUpperCase().replace(/^﻿/, ''));
  const kset = new Set(kopf);
  const oz = OHNE_ZIEL.find((o) => o.passt(kset));
  if (oz) return { ohneZiel: true, name, tabelle: oz.tabelle, grund: oz.grund, anzahl: lines.length - 1 };
  const art = erkennen(kopf);
  if (!art) return { fehler: `${name}: Datei nicht erkannt – erwartet werden die Exporte Aufträge, Aufträge_POs, Adressen (optional Träger, Produkte, Wertelisten, ZEU_RGNRKREIS).` };
  const map = MAP[art];
  const ignoriert = kopf.filter((k) => k && !map[k] && k !== 'MANDT' && k !== 'CLIENT');
  let fehler = 0;
  const zeilen: Record<string, unknown>[] = [];
  for (const line of lines.slice(1)) {
    const f = csvZeile(line);
    const row: Record<string, unknown> = {};
    kopf.forEach((k, i) => {
      const d = map[k];
      if (!d || f[i] === undefined) return;
      try {
        const v = konvertieren(f[i], d.conv);
        if (v !== undefined) row[d.col] = v;
      } catch {
        fehler++;
      }
    });
    zeilen.push(row);
  }
  let gueltig = zeilen;
  if (art === 'AUF') gueltig = zeilen.filter((r) => r.auftragsnr);
  if (art === 'POS' || art === 'TRG') gueltig = zeilen.filter((r) => r.auftragsnr && r.pos);
  if (art === 'ADR') gueltig = zeilen.filter((r) => r.adrnr);
  if (art === 'PRD') gueltig = zeilen.filter((r) => r.prod_key && r.text);
  if (art === 'NRK') gueltig = zeilen.filter((r) => r.jahr && r.typ && r.nummer !== undefined);
  if (art === 'WRT') {
    gueltig = zeilen
      .filter((r) => DOMAENE[String(r.typ ?? '').toUpperCase()] && r.schluessel && r.text)
      .map((r) => ({ ...r, typ: DOMAENE[String(r.typ).toUpperCase()] }));
  }
  return { art, name, zeilen: gueltig, alle: zeilen.length, ignoriert, unlesbar: fehler };
}

// ---------------------------------------------------------------------------
// Prüfen und Ausführen
// ---------------------------------------------------------------------------
export interface Status {
  key: ImportArt | 'IGN';
  datei: string;
  tabelle: string;
  status: string;
  state: 'None' | 'Positive' | 'Negative' | 'Critical';
  anzahl: number | null;
  neu: number | null;
  hinweis: string;
}

type TabArt = Exclude<ImportArt, 'NRK'>;
const KEY: Record<TabArt, string[]> = {
  AUF: ['auftragsnr'], POS: ['auftragsnr', 'pos'], ADR: ['adrnr'], TRG: ['auftragsnr', 'pos'], PRD: ['prod_key'], WRT: ['typ', 'schluessel'],
};
const TABELLE: Record<TabArt, string> = {
  AUF: 'transport.auftraege', POS: 'transport.stops', ADR: 'transport.adressen', TRG: 'transport.traeger', PRD: 'transport.produkte', WRT: 'transport.werte',
};
const keyOf = (art: TabArt, r: Record<string, unknown>) => KEY[art].map((k) => String(r[k])).join('|');

async function vorhandeneSchluessel(db: Tx, art: TabArt): Promise<Set<string>> {
  const cols = KEY[art];
  const rows = await db.unsafe(`select ${cols.join(', ')} from ${TABELLE[art]}`);
  return new Set(rows.map((r) => cols.map((c) => String(r[c])).join('|')));
}

/** Tabellen, die der Neuaufbau leert (Reihenfolge egal – ein TRUNCATE für alle). */
function zuLeeren(dateien: Geparst[]): TabArt[] {
  const t: TabArt[] = ['TRG', 'POS', 'AUF', 'ADR'];
  if (dateien.some((d) => d.art === 'PRD')) t.push('PRD');
  if (dateien.some((d) => d.art === 'WRT')) t.push('WRT');
  return t;
}

/** Nummernkreise aus ZEU_RGNRKREIS: id|jahr → Nummer (nur Typ A und R) */
function nummernAusDatei(d: Geparst | undefined): { werte: Map<string, number>; unbekannt: string[] } {
  const werte = new Map<string, number>();
  const unbekannt = new Set<string>();
  for (const r of d?.zeilen ?? []) {
    const typ = String(r.typ).toUpperCase();
    const id = NRK_TYP[typ];
    if (!id) { unbekannt.add(typ); continue; }
    const k = `${id}|${r.jahr}`;
    werte.set(k, Math.max(werte.get(k) ?? 0, Number(r.nummer)));
  }
  return { werte, unbekannt: [...unbekannt].sort() };
}

export async function pruefen(
  db: Tx, dateien: Geparst[], fehlerDateien: string[], ohneZiel: OhneZiel[] = [], modus: ImportModus = 'neu',
): Promise<Status[]> {
  const res: Status[] = [];
  const leeren = modus === 'ersetzen' ? zuLeeren(dateien) : [];
  for (const def of IMPORT_ARTEN) {
    const d = dateien.find((x) => x.art === def.key);
    const s: Status = { key: def.key, datei: def.datei, tabelle: def.tabelle, status: 'nicht eingelesen', state: 'None', anzahl: null, neu: null, hinweis: '' };
    if (!d && modus === 'ersetzen' && PFLICHT_NEUAUFBAU.includes(def.key)) {
      Object.assign(s, { state: 'Negative', hinweis: 'Für den Neuaufbau erforderlich' });
    }
    if (d && def.key === 'NRK') {
      const { werte, unbekannt } = nummernAusDatei(d);
      const akt = new Map((await db`select id, year, last_value from core.number_ranges where id in (${NR_AUFTRAG}, ${NR_RECHNUNG})`)
        .map((r) => [`${r.id}|${r.year}`, Number(r.last_value)]));
      const neu = [...werte].filter(([k, n]) => (modus === 'ersetzen' ? akt.get(k) !== n : (akt.get(k) ?? -1) < n)).length;
      const hinweise = [modus === 'ersetzen' ? 'Nummernkreise werden genau auf den SAP-Stand gesetzt' : 'Nummernkreise werden nur hochgezogen'];
      if (unbekannt.length) hinweise.push(`Typ ${unbekannt.join(', ')} wird ignoriert (nur A = Auftrag, R = Rechnung)`);
      Object.assign(s, { datei: d.name, status: 'eingelesen', state: 'Positive', anzahl: werte.size, neu, hinweis: hinweise.join(' · ') });
    } else if (d) {
      const art = def.key as TabArt;
      const hinweise: string[] = [];
      let neu: number;
      if (leeren.includes(art)) {
        const [{ n }] = await db.unsafe(`select count(*)::int as n from ${TABELLE[art]}`);
        neu = d.zeilen.length;
        hinweise.push(`Tabelle wird vorher geleert (${n} vorhandene Sätze)`);
        if (art === 'AUF') {
          const inDatei = new Set(d.zeilen.map((r) => String(r.auftragsnr)));
          const weg = (await db`select auftragsnr from transport.auftraege`).filter((r) => !inDatei.has(r.auftragsnr as string)).length;
          if (weg) hinweise.push(`${weg} Auftrag/Aufträge im Portal fehlen in der Datei und gehen verloren`);
        }
      } else {
        const vorh = await vorhandeneSchluessel(db, art);
        neu = d.zeilen.filter((r) => !vorh.has(keyOf(art, r))).length;
        if (art === 'ADR') {
          const leer = await db`select adrnr from transport.adressen where coalesce(kundenname, '') = '' and coalesce(kundenname2, '') = ''`;
          const leerSet = new Set(leer.map((r) => Number(r.adrnr)));
          const ergaenz = d.zeilen.filter((r) => leerSet.has(Number(r.adrnr)) && (r.kundenname || r.kundenname2)).length;
          if (ergaenz) hinweise.push(`${ergaenz} leere Adresse(n) werden ergänzt`);
        }
      }
      if (d.alle > d.zeilen.length) hinweise.push(`${d.alle - d.zeilen.length} Zeile(n) ohne Schlüssel werden übersprungen`);
      if (d.ignoriert.length) hinweise.push(`Spalte ${d.ignoriert.join(', ')} wird ignoriert`);
      if (d.unlesbar) hinweise.push(`${d.unlesbar} Wert(e) nicht lesbar`);
      Object.assign(s, { datei: d.name, status: 'eingelesen', state: 'Positive', anzahl: d.zeilen.length, neu, hinweis: hinweise.join(' · ') });
    }
    res.push(s);
  }
  for (const o of ohneZiel) {
    res.push({
      key: 'IGN', datei: o.name, tabelle: o.tabelle, status: 'nicht benötigt', state: 'None', anzahl: o.anzahl, neu: null,
      hinweis: `${o.grund} – wird nicht übernommen`,
    });
  }
  for (const f of fehlerDateien) {
    res.push({ key: 'IGN', datei: f.split(':')[0], tabelle: '–', status: 'nicht erkannt', state: 'Negative', anzahl: null, neu: null, hinweis: f });
  }
  return res;
}

const COLS: Record<ImportArt, string[]> = Object.fromEntries(
  (Object.keys(MAP) as ImportArt[]).map((a) => [a, [...new Set(Object.values(MAP[a]).map((d) => d.col))]]),
) as Record<ImportArt, string[]>;

/** Neue Sätze anlegen – gebündelt je gleicher Spaltenauswahl (schneller beim Neuaufbau mit vielen Tausend Zeilen). */
async function einfuegen(tx: Tx, art: TabArt, zeilen: Record<string, unknown>[]): Promise<number> {
  const vorh = await vorhandeneSchluessel(tx, art);
  const gruppen = new Map<string, Record<string, unknown>[]>();
  for (const r of zeilen) {
    const k = keyOf(art, r);
    if (vorh.has(k)) continue;
    vorh.add(k);
    const cols = COLS[art].filter((c) => r[c] !== undefined);
    const sig = cols.join(',');
    if (!gruppen.has(sig)) gruppen.set(sig, []);
    gruppen.get(sig)!.push(r);
  }
  const [schema, tabelle] = TABELLE[art].split('.');
  let n = 0;
  for (const [sig, rows] of gruppen) {
    const cols = sig.split(',');
    for (let i = 0; i < rows.length; i += 500) {
      const teil = rows.slice(i, i + 500);
      await tx`insert into ${tx(schema)}.${tx(tabelle)} ${tx(teil, ...cols)}`;
      n += teil.length;
    }
  }
  return n;
}

export interface Ergebnis {
  text: string;
}

/** Reihenfolge: Werte, Produkte, Adressen, Aufträge, Stops, Träger (wegen Fremdschlüsseln). */
export async function ausfuehren(tx: Tx, dateien: Geparst[], modus: ImportModus = 'neu'): Promise<Ergebnis> {
  const get = (a: ImportArt) => dateien.find((d) => d.art === a)?.zeilen ?? [];
  const zaehl: Partial<Record<TabArt, number>> = {};
  const ersetzen = modus === 'ersetzen';

  // ---- Neuaufbau: Tabellen leeren (ein TRUNCATE – keine Einzel-Löschbelege, Fremdschlüssel bleiben gültig) ----
  let geleert: string[] = [];
  let doks: Record<string, unknown>[] = [];
  if (ersetzen) {
    const fehlt = PFLICHT_NEUAUFBAU.filter((a) => !dateien.some((d) => d.art === a));
    if (fehlt.length) {
      throw new BusinessError(`Für den Neuaufbau fehlen: ${IMPORT_ARTEN.filter((d) => fehlt.includes(d.key)).map((d) => d.datei).join(', ')}.`);
    }
    doks = [...await tx`select * from transport.auftrag_dokumente`];
    const tab = zuLeeren(dateien);
    await tx.unsafe(`truncate transport.auftrag_dokumente, ${tab.map((a) => TABELLE[a]).join(', ')}`);
    geleert = IMPORT_ARTEN.filter((d) => tab.includes(d.key as TabArt)).map((d) => d.tabelle.replace(/ \(.*\)$/, ''));
  }

  zaehl.WRT = await einfuegen(tx, 'WRT', get('WRT'));
  zaehl.PRD = await einfuegen(tx, 'PRD', get('PRD'));

  // Adressen: neue anlegen, vorhandene leere ergänzen
  const adr = get('ADR');
  const leer = new Set(
    (await tx`select adrnr from transport.adressen where coalesce(kundenname, '') = '' and coalesce(kundenname2, '') = ''`).map((r) => Number(r.adrnr)),
  );
  zaehl.ADR = await einfuegen(tx, 'ADR', adr);
  let ergaenzt = 0;
  for (const r of adr) {
    if (!leer.has(Number(r.adrnr)) || !(r.kundenname || r.kundenname2)) continue;
    const cols = COLS.ADR.filter((c) => c !== 'adrnr' && r[c] !== undefined);
    await tx`update transport.adressen set ${tx(r, ...cols)} where adrnr = ${r.adrnr as number}`;
    ergaenzt++;
  }

  // Aufträge: fehlende Adressen als Platzhalter anlegen (Fremdschlüssel)
  const auf = get('AUF');
  const bekannt = new Set((await tx`select adrnr from transport.adressen`).map((r) => Number(r.adrnr)));
  let platzhalter = 0;
  for (const r of auf) {
    for (const f of ['kunde', 'unternehmer', 'rechnungsempfaenger']) {
      const nr = r[f] as number | null | undefined;
      if (nr && !bekannt.has(nr)) {
        await tx`insert into transport.adressen (adrnr, kundenname) values (${nr}, '')`;
        bekannt.add(nr);
        platzhalter++;
      }
    }
    if (!r.anlagedatum) r.anlagedatum = `${String(r.auftragsnr).slice(0, 4)}-01-01`;
    if (r.lademeter === 0) delete r.lademeter; // SAP: 0.0 = nicht gepflegt
  }
  zaehl.AUF = await einfuegen(tx, 'AUF', auf);

  // Stops/Träger nur zu vorhandenen Aufträgen
  const auftragsnr = new Set((await tx`select auftragsnr from transport.auftraege`).map((r) => r.auftragsnr as string));
  const pos = get('POS').filter((r) => auftragsnr.has(String(r.auftragsnr)));
  const trg = get('TRG').filter((r) => auftragsnr.has(String(r.auftragsnr)));
  const ohneAuftrag = get('POS').length - pos.length + get('TRG').length - trg.length;
  zaehl.POS = await einfuegen(tx, 'POS', pos);
  zaehl.TRG = await einfuegen(tx, 'TRG', trg);

  // Dokumentverknüpfungen der wieder vorhandenen Aufträge zurückschreiben
  let doksZurueck = 0;
  const doksBehalten = doks.filter((d) => auftragsnr.has(d.auftragsnr as string));
  for (let i = 0; i < doksBehalten.length; i += 500) {
    const teil = doksBehalten.slice(i, i + 500);
    await tx`insert into transport.auftrag_dokumente ${tx(teil, 'auftragsnr', 'doc_id', 'titel', 'datei', 'erstellt_am', 'erstellt_von')}`;
    doksZurueck += teil.length;
  }
  const doksWeg = doks.length - doksZurueck;

  // Nummernkreise (A = Auftrag, R = Rechnung): höchste importierte Nummer je Jahr, ggf. Stand aus ZEU_RGNRKREIS
  const nk: string[] = [];
  const max = new Map<string, number>();
  for (const r of auf) {
    for (const [id, v] of [[NR_AUFTRAG, r.auftragsnr], [NR_RECHNUNG, r.faktura]] as const) {
      const m = /^(\d{4})_(\d{4})$/.exec(String(v ?? ''));
      if (!m) continue;
      const k = `${id}|${m[1]}`;
      max.set(k, Math.max(max.get(k) ?? 0, Number(m[2])));
    }
  }
  const nrk = dateien.find((d) => d.art === 'NRK');
  const { werte: ausDatei } = nummernAusDatei(nrk);
  for (const [k, n] of ausDatei) max.set(k, Math.max(max.get(k) ?? 0, n));
  for (const [k, n] of [...max].sort(([a], [b]) => (a.split('|')[1] + a).localeCompare(b.split('|')[1] + b))) {
    const [id, jahr] = k.split('|');
    // Neuaufbau mit ZEU_RGNRKREIS: genau setzen (auch herunter); sonst nur hochziehen
    const geaendert = ersetzen && nrk
      ? (await tx`insert into core.number_ranges (id, year, last_value) values (${id}, ${Number(jahr)}, ${n})
                  on conflict (id, year) do update set last_value = excluded.last_value
                   where core.number_ranges.last_value <> excluded.last_value returning 1`).count > 0
      : await nummernkreisNachziehen(tx, id, Number(jahr), n);
    if (geaendert) nk.push(`${jahr} ${id === NR_AUFTRAG ? 'A' : 'R'} → ${String(n).padStart(4, '0')}`);
  }

  const tabArten = Object.keys(zaehl) as TabArt[];
  const alt = tabArten.reduce((s, a) => s + get(a).length - (zaehl[a] ?? 0), 0) - ergaenzt - ohneAuftrag;
  const text = [
    ersetzen ? `Neuaufbau: ${geleert.join(', ')} wurden geleert.` : '',
    `Neu angelegt: ${zaehl.AUF} Aufträge, ${zaehl.POS} Stops, ${zaehl.ADR} Adressen, ${zaehl.TRG} Trägerpositionen, ${zaehl.PRD} Produkte, ${zaehl.WRT} Listenwerte.`,
    ergaenzt ? `${ergaenzt} leere Adresse(n) aus der Datei ergänzt.` : '',
    platzhalter ? `${platzhalter} fehlende Adresse(n) als leere Platzhalter angelegt (mit Adressen.csv nachimportieren).` : '',
    ohneAuftrag > 0 ? `${ohneAuftrag} Stop-/Trägerzeile(n) ohne zugehörigen Auftrag übersprungen.` : '',
    alt > 0 ? `${alt} ${ersetzen ? 'doppelte Sätze in den Dateien wurden übersprungen.' : 'bereits vorhandene Sätze wurden nicht verändert.'}` : '',
    doksZurueck ? `${doksZurueck} Dokumentverknüpfung(en) zu Aufträgen übernommen.` : '',
    doksWeg ? `${doksWeg} Dokumentverknüpfung(en) entfallen (Auftrag nicht mehr vorhanden; die Dokumente bleiben in Paperless).` : '',
    nk.length ? `Nummernkreise ${ersetzen && nrk ? 'gesetzt' : 'angepasst'}: ${nk.join(', ')}` : '',
  ].filter(Boolean).join('\n');
  return { text };
}
