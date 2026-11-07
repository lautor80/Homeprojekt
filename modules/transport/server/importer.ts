import type { Tx } from '../../../server/src/db.js';
import { NR_AUFTRAG, NR_RECHNUNG, nummernkreisNachziehen } from './data.js';

/**
 * CSV-Import der SAP-Exporte (ZEU_ARCHIVE / SE16 / Excel), wie IMPORT_* in Z2UI5_CL_EU_AUFTRAG:
 *  - Semikolon-CSV mit Kopfzeile, Spalten werden über die SAP-Feldnamen zugeordnet
 *  - Datei wird am Spaltenkopf erkannt (Dateiname egal)
 *  - nur neue Sätze werden angelegt, vorhandene bleiben unverändert
 *    (Ausnahme: vorhandene, aber leere Adressen werden aus der Datei ergänzt)
 *  - Nummernkreise werden auf die höchste importierte Nummer je Jahr gezogen
 * Zusätzlich zur ABAP-Version: Träger (ZEU_TRAEGER), Produkte (ZEU_PRODUKTE) und
 * Wertelisten (DD07T/DD07V der Domänen ZEU_LADEART, ZEU_LADEGUT, ZEU_LADEWEISE, ZEU_PALETTENTAUSCH).
 */

export type ImportArt = 'AUF' | 'POS' | 'ADR' | 'TRG' | 'PRD' | 'WRT';

export const IMPORT_ARTEN: { key: ImportArt; datei: string; tabelle: string }[] = [
  { key: 'AUF', datei: 'Aufträge.csv', tabelle: 'Aufträge (ZEU_AUFTRAG)' },
  { key: 'POS', datei: 'Aufträge_POs.csv', tabelle: 'Stops (ZEU_AUFTAG_POS)' },
  { key: 'ADR', datei: 'Adressen.csv', tabelle: 'Adressen (ZEU_ADRESSEN)' },
  { key: 'TRG', datei: 'Träger.csv', tabelle: 'Holzträger (ZEU_TRAEGER)' },
  { key: 'PRD', datei: 'Produkte.csv', tabelle: 'Produkte (ZEU_PRODUKTE)' },
  { key: 'WRT', datei: 'Wertelisten.csv', tabelle: 'Wertelisten (DD07T)' },
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

export interface Geparst {
  art: ImportArt;
  name: string;
  zeilen: Record<string, unknown>[];
  alle: number;
  ignoriert: string[];
  unlesbar: number;
}

export function parsen(name: string, csv: string): Geparst | { fehler: string } {
  const lines = csv.split('\n').filter((l) => l.trim());
  if (!lines.length) return { fehler: `${name}: Die Datei ist leer oder nicht lesbar.` };
  const kopf = csvZeile(lines[0]).map((s) => s.trim().toUpperCase().replace(/^﻿/, ''));
  const art = erkennen(kopf);
  if (!art) return { fehler: `${name}: Datei nicht erkannt – erwartet werden die Exporte Aufträge, Aufträge_POs, Adressen (optional Träger, Produkte, Wertelisten).` };
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
  key: ImportArt;
  datei: string;
  tabelle: string;
  status: string;
  state: 'None' | 'Positive' | 'Negative' | 'Critical';
  anzahl: number | null;
  neu: number | null;
  hinweis: string;
}

const KEY: Record<ImportArt, string[]> = {
  AUF: ['auftragsnr'], POS: ['auftragsnr', 'pos'], ADR: ['adrnr'], TRG: ['auftragsnr', 'pos'], PRD: ['prod_key'], WRT: ['typ', 'schluessel'],
};
const TABELLE: Record<ImportArt, string> = {
  AUF: 'transport.auftraege', POS: 'transport.stops', ADR: 'transport.adressen', TRG: 'transport.traeger', PRD: 'transport.produkte', WRT: 'transport.werte',
};
const keyOf = (art: ImportArt, r: Record<string, unknown>) => KEY[art].map((k) => String(r[k])).join('|');

async function vorhandeneSchluessel(db: Tx, art: ImportArt): Promise<Set<string>> {
  const cols = KEY[art];
  const rows = await db.unsafe(`select ${cols.join(', ')} from ${TABELLE[art]}`);
  return new Set(rows.map((r) => cols.map((c) => String(r[c])).join('|')));
}

export async function pruefen(db: Tx, dateien: Geparst[], fehlerDateien: string[]): Promise<Status[]> {
  const res: Status[] = [];
  for (const def of IMPORT_ARTEN) {
    const d = dateien.find((x) => x.art === def.key);
    const s: Status = { key: def.key, datei: def.datei, tabelle: def.tabelle, status: 'nicht eingelesen', state: 'None', anzahl: null, neu: null, hinweis: '' };
    if (d) {
      const vorh = await vorhandeneSchluessel(db, def.key);
      const neu = d.zeilen.filter((r) => !vorh.has(keyOf(def.key, r))).length;
      const hinweise: string[] = [];
      if (d.alle > d.zeilen.length) hinweise.push(`${d.alle - d.zeilen.length} Zeile(n) ohne Schlüssel werden übersprungen`);
      if (def.key === 'ADR') {
        const leer = await db`select adrnr from transport.adressen where coalesce(kundenname, '') = '' and coalesce(kundenname2, '') = ''`;
        const leerSet = new Set(leer.map((r) => Number(r.adrnr)));
        const ergaenz = d.zeilen.filter((r) => leerSet.has(Number(r.adrnr)) && (r.kundenname || r.kundenname2)).length;
        if (ergaenz) hinweise.push(`${ergaenz} leere Adresse(n) werden ergänzt`);
      }
      if (d.ignoriert.length) hinweise.push(`Spalte ${d.ignoriert.join(', ')} wird ignoriert`);
      if (d.unlesbar) hinweise.push(`${d.unlesbar} Wert(e) nicht lesbar`);
      Object.assign(s, { datei: d.name, status: 'eingelesen', state: 'Positive', anzahl: d.zeilen.length, neu, hinweis: hinweise.join(' · ') });
    }
    res.push(s);
  }
  for (const f of fehlerDateien) {
    res.push({ key: 'AUF', datei: f.split(':')[0], tabelle: '–', status: 'nicht erkannt', state: 'Negative', anzahl: null, neu: null, hinweis: f });
  }
  return res;
}

const COLS: Record<ImportArt, string[]> = Object.fromEntries(
  (Object.keys(MAP) as ImportArt[]).map((a) => [a, [...new Set(Object.values(MAP[a]).map((d) => d.col))]]),
) as Record<ImportArt, string[]>;

async function einfuegen(tx: Tx, art: ImportArt, zeilen: Record<string, unknown>[]): Promise<number> {
  let n = 0;
  const vorh = await vorhandeneSchluessel(tx, art);
  for (const r of zeilen) {
    const k = keyOf(art, r);
    if (vorh.has(k)) continue;
    const cols = COLS[art].filter((c) => r[c] !== undefined);
    await tx`insert into ${tx(TABELLE[art].split('.')[0])}.${tx(TABELLE[art].split('.')[1])} ${tx(r, ...cols)}`;
    vorh.add(k);
    n++;
  }
  return n;
}

export interface Ergebnis {
  text: string;
}

/** Reihenfolge: Werte, Produkte, Adressen, Aufträge, Stops, Träger (wegen Fremdschlüsseln). */
export async function ausfuehren(tx: Tx, dateien: Geparst[]): Promise<Ergebnis> {
  const get = (a: ImportArt) => dateien.find((d) => d.art === a)?.zeilen ?? [];
  const zaehl: Record<string, number> = {};

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

  // Nummernkreise (A = Auftrag, R = Rechnung) auf die höchste importierte Nummer je Jahr
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
  for (const [k, n] of max) {
    const [id, jahr] = k.split('|');
    if (await nummernkreisNachziehen(tx, id, Number(jahr), n)) nk.push(`${jahr} ${id === NR_AUFTRAG ? 'A' : 'R'} → ${String(n).padStart(4, '0')}`);
  }

  const alt = (Object.keys(zaehl) as ImportArt[]).reduce((s, a) => s + get(a).length - zaehl[a], 0) - ergaenzt - ohneAuftrag;
  const text = [
    `Neu angelegt: ${zaehl.AUF} Aufträge, ${zaehl.POS} Stops, ${zaehl.ADR} Adressen, ${zaehl.TRG} Trägerpositionen, ${zaehl.PRD} Produkte, ${zaehl.WRT} Listenwerte.`,
    ergaenzt ? `${ergaenzt} leere Adresse(n) aus der Datei ergänzt.` : '',
    platzhalter ? `${platzhalter} fehlende Adresse(n) als leere Platzhalter angelegt (mit Adressen.csv nachimportieren).` : '',
    ohneAuftrag > 0 ? `${ohneAuftrag} Stop-/Trägerzeile(n) ohne zugehörigen Auftrag übersprungen.` : '',
    alt > 0 ? `${alt} bereits vorhandene Sätze wurden nicht verändert.` : '',
    nk.length ? `Nummernkreise angepasst: ${nk.join(', ')}` : '',
  ].filter(Boolean).join('\n');
  return { text };
}
