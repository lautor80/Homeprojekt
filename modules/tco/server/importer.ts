import { csvParse, dekodieren, sapBetrag, sapBool, sapDatum, sapZeit } from '../../../server/src/lib/sapcsv.js';
import type { Db } from './verein.js';

/**
 * Übernahme der SAP-Tabellen aus den CSV-Exporten von ZTCO_ARCHIVE (CL_ICF_CSV).
 * Dateiname bestimmt die Tabelle (ZTCO_RGKOPF.CSV → tco.rgkopf, BANKAB.CSV → tco.fibankab).
 * Spalten werden über die SAP-Feldnamen zugeordnet, Werte nach dem Spaltentyp umgesetzt.
 * Modus „neu“: nur neue Schlüssel anlegen; „aktualisieren“: vorhandene Sätze überschreiben.
 */

/** Reihenfolge = Ladereihenfolge (Fremdschlüssel: Rechnungskopf vor Positionen) */
export const TABELLEN = [
  'mitglieder', 'mitgliedera', 'sepa', 'vertraege', 'beitrag', 'beitrag_pr', 'mgnotiz', 'kommpref', 'schluessel', 'antrag_map',
  'kunden', 'bookings', 'bookings_ch', 'bookingstxt', 'produkte', 'prmatrix', 'rgkopf', 'rgpos', 'rgtz',
  'fikonten', 'fikontojahr', 'fibuchungen', 'fibankab', 'finotiz', 'fipapermap', 'paperless', 'projekte', 'anlagen',
  'soll_cfg', 'soll_kopf', 'soll_pos', 'ford', 'forderungen', 'werg', 'werg_beleg', 'werg_pl',
  'jrueckm', 'jt_doku', 'trentgelt', 'tplan', 'tfrei', 'ferien',
] as const;

const ALIAS: Record<string, string> = { BANKAB: 'fibankab' };

export function tabelleZuDatei(name: string): string | null {
  const stem = name.replace(/^.*[\\/]/, '').replace(/\.(csv|txt)$/i, '').toUpperCase().replace(/^ZTCO_/, '');
  const t = ALIAS[stem] ?? stem.toLowerCase();
  return (TABELLEN as readonly string[]).includes(t) ? t : null;
}

interface Spalte { name: string; typ: string; nullbar: boolean; vorgabe: string | null; schluessel: boolean }

async function spalten(db: Db, tabelle: string): Promise<Spalte[]> {
  const rows = await db`
    select c.column_name as name, c.data_type as typ, c.is_nullable = 'YES' as nullbar, c.column_default as vorgabe,
           exists (select 1 from information_schema.key_column_usage k
                     join information_schema.table_constraints tc on tc.constraint_name = k.constraint_name and tc.table_schema = k.table_schema
                    where tc.constraint_type = 'PRIMARY KEY' and k.table_schema = 'tco' and k.table_name = c.table_name
                      and k.column_name = c.column_name) as schluessel
      from information_schema.columns c
     where c.table_schema = 'tco' and c.table_name = ${tabelle}
     order by c.ordinal_position`;
  return rows as unknown as Spalte[];
}

function wandeln(v: string, s: Spalte): unknown {
  const t = v.trim();
  switch (s.typ) {
    case 'date': return sapDatum(t);
    case 'time without time zone': return sapZeit(t);
    case 'numeric': case 'double precision': return sapBetrag(t);
    case 'integer': case 'smallint': case 'bigint': {
      if (!t) return null;
      const n = sapBetrag(t);
      return n === null ? null : Math.trunc(n);
    }
    case 'boolean': return sapBool(t);
    case 'timestamp with time zone': {
      if (!t || /^0+$/.test(t)) return null;
      const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(t.replace(/[^\d]/g, ''));
      return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z` : null;
    }
    default: return t === '' ? null : t;
  }
}

export interface DateiErgebnis {
  datei: string;
  tabelle: string | null;
  saetze: number;
  neu: number;
  fehler: string[];
  ignoriert: string[];
  geschrieben?: number;
}

interface Vorbereitet { erg: DateiErgebnis; zeilen: Record<string, unknown>[]; cols: Spalte[]; vorhanden: string[] }

async function vorbereiten(db: Db, datei: string, inhalt: Buffer): Promise<Vorbereitet> {
  const tabelle = tabelleZuDatei(datei);
  const erg: DateiErgebnis = { datei, tabelle, saetze: 0, neu: 0, fehler: [], ignoriert: [] };
  if (!tabelle) {
    erg.fehler.push('Datei keiner Tabelle zuordenbar (erwartet z. B. ZTCO_RGKOPF.CSV)');
    return { erg, zeilen: [], cols: [], vorhanden: [] };
  }
  const cols = await spalten(db, tabelle);
  const rows = csvParse(dekodieren(inhalt));
  if (!rows.length) {
    erg.fehler.push('Datei ist leer');
    return { erg, zeilen: [], cols, vorhanden: [] };
  }
  const kopf = rows[0].map((h) => h.trim().toLowerCase());
  const byName = new Map(cols.map((c) => [c.name, c]));
  erg.ignoriert = kopf.filter((h) => h && !byName.has(h) && h !== 'mandt' && h !== 'client');
  const vorhanden = kopf.filter((h) => byName.has(h));
  const keys = cols.filter((c) => c.schluessel).map((c) => c.name);
  const fehlend = keys.filter((k) => !vorhanden.includes(k));
  if (fehlend.length) {
    erg.fehler.push(`Schlüsselspalten fehlen: ${fehlend.join(', ').toUpperCase()}`);
    return { erg, zeilen: [], cols, vorhanden };
  }
  const zeilen: Record<string, unknown>[] = [];
  const gesehen = new Set<string>();
  rows.slice(1).forEach((r, i) => {
    const z: Record<string, unknown> = {};
    try {
      kopf.forEach((h, j) => {
        const c = byName.get(h);
        if (c) z[h] = wandeln(r[j] ?? '', c);
      });
    } catch (e) {
      if (erg.fehler.length < 10) erg.fehler.push(`Zeile ${i + 2}: ${(e as Error).message}`);
      return;
    }
    if (keys.some((k) => z[k] === null || z[k] === undefined || z[k] === '')) {
      if (erg.fehler.length < 10) erg.fehler.push(`Zeile ${i + 2}: Schlüssel leer`);
      return;
    }
    const kk = keys.map((k) => String(z[k])).join('|');
    if (gesehen.has(kk)) return; // doppelte Schlüssel in der Datei: erster Satz zählt
    gesehen.add(kk);
    zeilen.push(z);
  });
  erg.saetze = zeilen.length;
  // davon neu
  for (let i = 0; i < zeilen.length; i += 1000) {
    const teil = zeilen.slice(i, i + 1000);
    const on = keys.map((k) => `t.${k} = j.${k}`).join(' and ');
    const [{ n }] = await db.unsafe(
      `select count(*)::int as n from json_populate_recordset(null::tco.${tabelle}, $1::text::json) j
        where not exists (select 1 from tco.${tabelle} t where ${on})`, [JSON.stringify(teil)] as never);
    erg.neu += n;
  }
  return { erg, zeilen, cols, vorhanden };
}

export async function pruefen(db: Db, dateien: { name: string; inhalt: Buffer }[]): Promise<DateiErgebnis[]> {
  const out: DateiErgebnis[] = [];
  for (const d of dateien) out.push((await vorbereiten(db, d.name, d.inhalt)).erg);
  return out.sort((a, b) => TABELLEN.indexOf(a.tabelle as never) - TABELLEN.indexOf(b.tabelle as never));
}

export async function ausfuehren(tx: Db, dateien: { name: string; inhalt: Buffer }[], modus: 'neu' | 'aktualisieren'): Promise<DateiErgebnis[]> {
  const vor: Vorbereitet[] = [];
  for (const d of dateien) vor.push(await vorbereiten(tx, d.name, d.inhalt));
  vor.sort((a, b) => TABELLEN.indexOf(a.erg.tabelle as never) - TABELLEN.indexOf(b.erg.tabelle as never));
  for (const v of vor) {
    const t = v.erg.tabelle;
    if (!t || !v.zeilen.length || v.erg.fehler.some((f) => f.startsWith('Schlüssel'))) continue;
    const keys = v.cols.filter((c) => c.schluessel).map((c) => c.name);
    const sel = v.vorhanden.map((c) => {
      const s = v.cols.find((x) => x.name === c)!;
      return !s.nullbar && s.vorgabe ? `coalesce(j.${c}, ${s.vorgabe})` : `j.${c}`;
    });
    const upd = v.vorhanden.filter((c) => !keys.includes(c));
    const konflikt = modus === 'aktualisieren' && upd.length
      ? `do update set ${upd.map((c) => `${c} = excluded.${c}`).join(', ')}`
      : 'do nothing';
    let n = 0;
    for (let i = 0; i < v.zeilen.length; i += 1000) {
      const teil = v.zeilen.slice(i, i + 1000);
      const r = await tx.unsafe(
        `insert into tco.${t} (${v.vorhanden.join(', ')})
         select ${sel.join(', ')} from json_populate_recordset(null::tco.${t}, $1::text::json) j
         on conflict (${keys.join(', ')}) ${konflikt}`, [JSON.stringify(teil)] as never);
      n += r.count;
    }
    v.erg.geschrieben = n;
  }
  return vor.map((v) => v.erg);
}
