import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { sql, type Tx } from './db.js';
import { APP_ROOT } from './config.js';
import { BusinessError } from './errors.js';
import { activeModules } from './modules.js';

/**
 * Sicherung und Rücksicherung aller Daten und Einstellungen über alle Anwendungen hinweg.
 *
 * Eine Sicherung enthält je Schema (core = Basis, tco, transport, …) alle Tabellen im verlustfreien
 * COPY-Textformat, dazu ein Manifest (Zeitpunkt, Ersteller, Migrationsstand, Tabellen, Zeilen).
 * Datei: „PSIC1“ + Kennbyte (0 = offen, 1 = verschlüsselt) [+ Salz, IV, Tag] + gzip(JSON).
 * Verschlüsselung: AES-256-GCM, Schlüssel per scrypt aus dem Passwort.
 *
 * Rücksicherung: in EINER Transaktion, wahlweise je Schema. Trigger (Änderungsbelege, Fremdschlüssel-
 * Aktionen) sind dabei aus (session_replication_role = replica); danach werden alle Fremdschlüssel geprüft.
 * Neuere Spalten bekommen ihre Standardwerte, Sicherungen eines NEUEREN Portalstands werden abgelehnt.
 * Vor jeder Rücksicherung entsteht automatisch eine Sicherheitskopie des aktuellen Stands.
 */

export const FORMAT = 'portal-sicherung';
export const VERSION = 1;
const MAGIC = Buffer.from('PSIC1');
/** nie sichern: Anmeldesitzungen (werden bei Rücksicherung der Basis geleert) */
const NIE = new Set(['core.sessions']);
const AUDIT = new Set(['core.change_header', 'core.change_item']);

export const SCHEMA_TEXT: Record<string, string> = { core: 'Basis (Benutzer, Rollen, Einstellungen, API-Schlüssel, Änderungsbelege)' };

export interface TabelleInfo { name: string; spalten: { name: string; typ: string }[]; zeilen: number }
export interface Manifest {
  format: string;
  version: number;
  erstellt: string;
  von: string;
  notiz: string;
  art: 'manuell' | 'automatisch' | 'vor-ruecksicherung';
  schemas: string[];
  migrationen: string[];
  tabellen: TabelleInfo[];
  ausgeschlossen: string[];
  mitAenderungsbelegen: boolean;
}
interface Inhalt { manifest: Manifest; daten: Record<string, string> }

// ---------------------------------------------------------------------------
// Ablageort
// ---------------------------------------------------------------------------
export const dumpVerzeichnis = () => process.env.DUMP_DIR ?? path.join(APP_ROOT, 'data', 'backups');
let ordnerCache: { pfad: string; dauerhaft: boolean } | null = null;

/** Sicherungsordner; ist er nicht beschreibbar, wird ein temporärer Ordner genutzt (nicht dauerhaft) */
export async function ordner(): Promise<{ pfad: string; dauerhaft: boolean }> {
  if (ordnerCache) return ordnerCache;
  const soll = process.env.BACKUP_DIR ?? path.join(APP_ROOT, 'data', 'sicherungen');
  try {
    await fs.mkdir(soll, { recursive: true });
    await fs.access(soll, fs.constants.W_OK);
    ordnerCache = { pfad: soll, dauerhaft: true };
  } catch {
    const tmp = path.join(os.tmpdir(), 'portal-sicherungen');
    await fs.mkdir(tmp, { recursive: true });
    ordnerCache = { pfad: tmp, dauerhaft: false };
  }
  return ordnerCache;
}
export const ordnerZuruecksetzen = () => { ordnerCache = null; };

const NAME = /^[\w.-]+\.portal$/;
export function dateipfad(dir: string, name: string) {
  if (!NAME.test(name)) throw new BusinessError('Ungültiger Dateiname.');
  return path.join(dir, name);
}

const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
const voll = (t: string) => t.split('.').map(q).join('.');

// ---------------------------------------------------------------------------
// Katalog
// ---------------------------------------------------------------------------
export function aktiveSchemas(): string[] {
  return ['core', ...activeModules().filter((m) => m.migrationsDir).map((m) => m.id)];
}
export const schemaText = (s: string) => SCHEMA_TEXT[s] ?? activeModules().find((m) => m.id === s)?.name ?? s;

async function tabellen(db: Tx, schemas: string[]): Promise<{ name: string; spalten: { name: string; typ: string }[] }[]> {
  const rows = await db`
    select n.nspname || '.' || c.relname as name,
           json_agg(json_build_object('name', a.attname, 'typ', format_type(a.atttypid, a.atttypmod)) order by a.attnum) as spalten
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped and a.attgenerated = ''
     where c.relkind in ('r', 'p') and n.nspname = any(${schemas}) and not c.relispartition
     group by n.nspname, c.relname
     order by n.nspname, c.relname`;
  return rows.map((r) => ({ name: r.name as string, spalten: r.spalten as { name: string; typ: string }[] }));
}

/** Übersicht für die Oberfläche: je Schema Tabellen und Zeilen */
export async function uebersicht() {
  const schemas = aktiveSchemas();
  const tabs = await tabellen(sql as unknown as Tx, schemas);
  const zaehl = await sql`
    select n.nspname || '.' || c.relname as name, greatest(c.reltuples, 0)::bigint as geschaetzt
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where c.relkind = 'r' and n.nspname = any(${schemas})`;
  const schaetz = new Map(zaehl.map((r) => [r.name as string, Number(r.geschaetzt)]));
  const [{ groesse }] = await sql`select pg_database_size(current_database())::bigint as groesse`;
  return {
    datenbank: Number(groesse),
    schemas: schemas.map((s) => {
      const t = tabs.filter((x) => x.name.startsWith(`${s}.`) && !NIE.has(x.name));
      return { schema: s, text: schemaText(s), tabellen: t.length, zeilen: t.reduce((sum: number, x) => sum + Number(schaetz.get(x.name) ?? 0), 0) };
    }),
  };
}

// ---------------------------------------------------------------------------
// Sichern
// ---------------------------------------------------------------------------
async function copyTo(db: Tx, tabelle: string, spalten: string[]): Promise<string> {
  const stream = await db.unsafe(`copy ${voll(tabelle)} (${spalten.map(q).join(', ')}) to stdout`).readable();
  const teile: Buffer[] = [];
  for await (const c of stream) teile.push(Buffer.from(c as Buffer));
  return Buffer.concat(teile).toString('utf8');
}

export async function sichern(o: { schemas?: string[]; mitAenderungsbelegen?: boolean; von: string; notiz?: string; art?: Manifest['art'] }): Promise<Inhalt> {
  const aktiv = aktiveSchemas();
  const schemas = (o.schemas?.length ? o.schemas : aktiv).filter((s) => aktiv.includes(s));
  if (!schemas.length) throw new BusinessError('Bitte mindestens einen Bereich zum Sichern wählen.');
  const mitAudit = o.mitAenderungsbelegen !== false;
  // konsistenter Schnappschuss über alle Tabellen
  return sql.begin('isolation level repeatable read read only', async (tx) => {
    const db = tx as unknown as Tx;
    const tabs = (await tabellen(db, schemas)).filter((t) => !NIE.has(t.name) && (mitAudit || !AUDIT.has(t.name)));
    const migrationen = (await db`select id from public.schema_migrations order by id`).map((r) => r.id as string)
      .filter((id) => schemas.includes(id.split('/')[0]));
    const daten: Record<string, string> = {};
    const info: TabelleInfo[] = [];
    for (const t of tabs) {
      const text = await copyTo(db, t.name, t.spalten.map((s) => s.name));
      daten[t.name] = text;
      info.push({ ...t, zeilen: text ? text.split('\n').length - 1 : 0 });
    }
    const manifest: Manifest = {
      format: FORMAT, version: VERSION, erstellt: new Date().toISOString(), von: o.von, notiz: o.notiz?.trim() ?? '', art: o.art ?? 'manuell',
      schemas, migrationen, tabellen: info,
      ausgeschlossen: [...NIE, ...(mitAudit ? [] : [...AUDIT])], mitAenderungsbelegen: mitAudit,
    };
    return { manifest, daten };
  }) as Promise<Inhalt>;
}

// ---------------------------------------------------------------------------
// Datei (gzip, optional AES-256-GCM)
// ---------------------------------------------------------------------------
const schluessel = (passwort: string, salz: Buffer) => crypto.scryptSync(passwort, salz, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });

export function verpacken(inhalt: Inhalt, passwort?: string | null): Buffer {
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(inhalt), 'utf8'), { level: 6 });
  if (!passwort) return Buffer.concat([MAGIC, Buffer.from([0]), gz]);
  if (passwort.length < 8) throw new BusinessError('Das Passwort für die Sicherung muss mindestens 8 Zeichen haben.');
  const salz = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', schluessel(passwort, salz), iv);
  const daten = Buffer.concat([c.update(gz), c.final()]);
  return Buffer.concat([MAGIC, Buffer.from([1]), salz, iv, c.getAuthTag(), daten]);
}

export const istVerschluesselt = (b: Buffer) => b.subarray(0, 5).equals(MAGIC) && b[5] === 1;

export function entpacken(b: Buffer, passwort?: string | null): Inhalt {
  if (b.length < 6 || !b.subarray(0, 5).equals(MAGIC)) throw new BusinessError('Die Datei ist keine Portal-Sicherung.');
  let gz: Buffer;
  if (b[5] === 1) {
    if (!passwort) throw new BusinessError('Die Sicherung ist verschlüsselt – bitte das Passwort angeben.', 400);
    const salz = b.subarray(6, 22);
    const iv = b.subarray(22, 34);
    const tag = b.subarray(34, 50);
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', schluessel(passwort, salz), iv);
      d.setAuthTag(tag);
      gz = Buffer.concat([d.update(b.subarray(50)), d.final()]);
    } catch {
      throw new BusinessError('Das Passwort ist falsch oder die Datei ist beschädigt.');
    }
  } else gz = b.subarray(6);
  let inhalt: Inhalt;
  try { inhalt = JSON.parse(zlib.gunzipSync(gz).toString('utf8')); } catch { throw new BusinessError('Die Sicherung ist beschädigt und kann nicht gelesen werden.'); }
  if (inhalt?.manifest?.format !== FORMAT) throw new BusinessError('Die Datei ist keine Portal-Sicherung.');
  if (inhalt.manifest.version > VERSION) throw new BusinessError('Die Sicherung stammt von einer neueren Portalversion – bitte zuerst das Portal aktualisieren.');
  return inhalt;
}

/** Kurzbeschreibung neben der Datei (ohne Daten), damit die Liste ohne Passwort lesbar ist */
export const kurzinfo = (m: Manifest, verschluesselt: boolean) => ({
  erstellt: m.erstellt, von: m.von, notiz: m.notiz, art: m.art, schemas: m.schemas, verschluesselt, mitAenderungsbelegen: m.mitAenderungsbelegen,
  tabellen: m.tabellen.length, zeilen: m.tabellen.reduce((s, t) => s + t.zeilen, 0),
});

export async function speichern(inhalt: Inhalt, passwort?: string | null): Promise<{ name: string; groesse: number; dauerhaft: boolean }> {
  const { pfad, dauerhaft } = await ordner();
  const z = new Date(inhalt.manifest.erstellt);
  const p2 = (n: number) => String(n).padStart(2, '0');
  const stempel = `${z.getFullYear()}-${p2(z.getMonth() + 1)}-${p2(z.getDate())}_${p2(z.getHours())}${p2(z.getMinutes())}${p2(z.getSeconds())}`;
  const art = inhalt.manifest.art === 'vor-ruecksicherung' ? '_vor-ruecksicherung' : inhalt.manifest.art === 'automatisch' ? '_automatisch' : '';
  let name = `portal_${stempel}${art}.portal`;
  for (let i = 2; await fs.stat(path.join(pfad, name)).then(() => true, () => false); i++) name = `portal_${stempel}${art}_${i}.portal`;
  const datei = verpacken(inhalt, passwort);
  await fs.writeFile(path.join(pfad, name), datei, { mode: 0o600 });
  await fs.writeFile(path.join(pfad, `${name}.json`), JSON.stringify(kurzinfo(inhalt.manifest, !!passwort)), { mode: 0o600 });
  return { name, groesse: datei.length, dauerhaft };
}

export async function liste() {
  const { pfad, dauerhaft } = await ordner();
  const dateien = (await fs.readdir(pfad).catch(() => [] as string[])).filter((f) => NAME.test(f));
  const out = [];
  for (const name of dateien) {
    const st = await fs.stat(path.join(pfad, name)).catch(() => null);
    if (!st) continue;
    const info = await fs.readFile(path.join(pfad, `${name}.json`), 'utf8').then((t) => JSON.parse(t), () => null);
    let verschluesselt = info?.verschluesselt ?? false;
    if (!info) {
      const fh = await fs.open(path.join(pfad, name), 'r');
      const kopf = Buffer.alloc(6);
      await fh.read(kopf, 0, 6, 0);
      await fh.close();
      verschluesselt = istVerschluesselt(kopf);
    }
    out.push({ name, groesse: st.size, geaendert: st.mtime.toISOString(), info, verschluesselt });
  }
  out.sort((a, b) => (b.info?.erstellt ?? b.geaendert).localeCompare(a.info?.erstellt ?? a.geaendert));
  return { pfad, dauerhaft, dateien: out };
}

/** nächtliche pg_dump-Sicherungen des Backup-Containers (nur Anzeige/Download) */
export async function dumps() {
  const dir = dumpVerzeichnis();
  const dateien = (await fs.readdir(dir).catch(() => [] as string[])).filter((f) => /^[\w.-]+\.dump$/.test(f));
  const out = [];
  for (const name of dateien) {
    const st = await fs.stat(path.join(dir, name)).catch(() => null);
    if (st) out.push({ name, groesse: st.size, geaendert: st.mtime.toISOString() });
  }
  return out.sort((a, b) => b.geaendert.localeCompare(a.geaendert));
}

// ---------------------------------------------------------------------------
// Prüfen und Rücksichern
// ---------------------------------------------------------------------------
export interface SchemaPruefung {
  schema: string; text: string; status: 'gleich' | 'aelter' | 'neuer' | 'inaktiv';
  tabellen: number; zeilen: number; hinweise: string[];
}

export async function pruefen(inhalt: Inhalt): Promise<{ manifest: Manifest; schemas: SchemaPruefung[] }> {
  const m = inhalt.manifest;
  const aktiv = aktiveSchemas();
  const aktuell = new Set((await sql`select id from public.schema_migrations`).map((r) => r.id as string));
  const jetzt = await tabellen(sql as unknown as Tx, aktiv);
  const out: SchemaPruefung[] = [];
  for (const s of m.schemas) {
    const tabs = m.tabellen.filter((t) => t.name.startsWith(`${s}.`));
    const p: SchemaPruefung = { schema: s, text: schemaText(s), status: 'gleich', tabellen: tabs.length, zeilen: tabs.reduce((x, t) => x + t.zeilen, 0), hinweise: [] };
    if (!aktiv.includes(s)) {
      p.status = 'inaktiv';
      p.hinweise.push('Bereich ist in diesem Portal nicht aktiv – kann nicht zurückgesichert werden.');
      out.push(p);
      continue;
    }
    const migB = m.migrationen.filter((x) => x.startsWith(`${s}/`));
    const migA = [...aktuell].filter((x) => x.startsWith(`${s}/`));
    const unbekannt = migB.filter((x) => !aktuell.has(x));
    const fehlend = migA.filter((x) => !migB.includes(x));
    if (unbekannt.length) {
      p.status = 'neuer';
      p.hinweise.push(`Sicherung stammt von einem neueren Portalstand (${unbekannt.map((x) => x.split('/')[1]).join(', ')}) – bitte zuerst das Portal aktualisieren.`);
    } else if (fehlend.length) {
      p.status = 'aelter';
      p.hinweise.push(`Sicherung stammt von einem älteren Portalstand – ${fehlend.length} spätere Datenbankänderung(en) (${fehlend.map((x) => x.split('/')[1]).join(', ')}). Neue Felder erhalten Standardwerte, neue Tabellen bleiben leer; Datenumstellungen dieser Änderungen werden nicht erneut ausgeführt.`);
    }
    const jetztS = jetzt.filter((t) => t.name.startsWith(`${s}.`));
    for (const t of tabs) {
      const j = jetztS.find((x) => x.name === t.name);
      if (!j) { p.hinweise.push(`Tabelle ${t.name} gibt es nicht mehr – ihre Daten werden übersprungen.`); continue; }
      const weg = t.spalten.filter((sp) => !j.spalten.some((x) => x.name === sp.name)).map((x) => x.name);
      if (weg.length) p.hinweise.push(`${t.name}: Spalte(n) ${weg.join(', ')} gibt es nicht mehr – werden übersprungen.`);
    }
    if (s === 'core') p.hinweise.push('Benutzer, Rollen und Einstellungen werden ersetzt – alle Benutzer werden abgemeldet und melden sich mit den Kennwörtern aus der Sicherung an.');
    if (s === 'core' && !m.mitAenderungsbelegen) p.hinweise.push('Die Sicherung enthält keine Änderungsbelege – die vorhandenen Änderungsbelege bleiben erhalten.');
    out.push(p);
  }
  return { manifest: m, schemas: out };
}

async function fremdschluesselPruefen(tx: Tx, schemas: string[]): Promise<{ fehler: string[]; bereinigt: string[] }> {
  const fks = await tx`
    select con.conname, cn.nspname || '.' || c.relname as kind, pn.nspname || '.' || p.relname as eltern, con.confdeltype,
           (select array_agg(a.attname order by k.ord) from unnest(con.conkey) with ordinality k(n, ord) join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.n) as kspalten,
           (select array_agg(a.attname order by k.ord) from unnest(con.confkey) with ordinality k(n, ord) join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.n) as espalten
      from pg_constraint con
      join pg_class c on c.oid = con.conrelid join pg_namespace cn on cn.oid = c.relnamespace
      join pg_class p on p.oid = con.confrelid join pg_namespace pn on pn.oid = p.relnamespace
     where con.contype = 'f' and (cn.nspname = any(${schemas}) or pn.nspname = any(${schemas}))`;
  const fehler: string[] = [];
  const bereinigt: string[] = [];
  for (const f of fks) {
    const ks = f.kspalten as string[];
    const es = f.espalten as string[];
    const bed = `${ks.map((k) => `c.${q(k)} is not null`).join(' and ')} and not exists (select 1 from ${voll(f.eltern)} p where ${ks.map((k, i) => `p.${q(es[i])} = c.${q(k)}`).join(' and ')})`;
    const [{ n }] = await tx.unsafe(`select count(*)::int as n from ${voll(f.kind)} c where ${bed}`);
    if (!n) continue;
    const kindSchema = (f.kind as string).split('.')[0];
    // Verweise aus NICHT zurückgesicherten Bereichen mit „on delete set null“ (z. B. Trainer → Portal-Benutzer) leeren
    if (f.confdeltype === 'n' && !schemas.includes(kindSchema)) {
      await tx.unsafe(`update ${voll(f.kind)} c set ${ks.map((k) => `${q(k)} = null`).join(', ')} where ${bed}`);
      bereinigt.push(`${f.kind}: ${n} Verweis(e) auf ${f.eltern} geleert (Datensatz nicht mehr vorhanden)`);
    } else {
      fehler.push(`${f.kind} → ${f.eltern}: ${n} Datensatz/Datensätze verweisen auf nicht vorhandene Einträge`);
    }
  }
  return { fehler, bereinigt };
}

/**
 * Rücksicherung ausgewählter Bereiche in einer Transaktion. Alles oder nichts.
 */
export async function ruecksichern(inhalt: Inhalt, schemas: string[]): Promise<{ text: string; hinweise: string[]; abgemeldet: boolean }> {
  const pr = await pruefen(inhalt);
  if (!schemas.length) throw new BusinessError('Bitte mindestens einen Bereich zum Zurücksichern wählen.');
  for (const s of schemas) {
    const p = pr.schemas.find((x) => x.schema === s);
    if (!p) throw new BusinessError(`Der Bereich „${schemaText(s)}“ ist in der Sicherung nicht enthalten.`);
    if (p.status === 'neuer' || p.status === 'inaktiv') throw new BusinessError(`${p.text}: ${p.hinweise[0]}`);
  }
  const m = inhalt.manifest;
  const hinweise: string[] = [];
  let zeilen = 0;

  await sql.begin(async (t) => {
    const tx = t as unknown as Tx;
    const [su] = await tx`select rolsuper from pg_roles where rolname = current_user`;
    if (!su?.rolsuper) throw new BusinessError('Für die Rücksicherung braucht der Datenbank-Benutzer des Portals Superuser-Rechte (Standard der Installation).');
    await tx`select pg_advisory_xact_lock(4711)`;
    await tx`set local session_replication_role = replica`;
    await tx`set local statement_timeout = 0`;

    const jetzt = await tabellen(tx, schemas);
    const gesichert = new Set(m.tabellen.map((x) => x.name));
    const ausgeschlossen = new Set(m.ausgeschlossen);
    // 1. leeren: alle Tabellen der Bereiche – außer ausgeschlossenen (Sitzungen nur bei Basis, Änderungsbelege nur wenn mitgesichert)
    for (const tab of jetzt) {
      if (tab.name === 'core.sessions') { await tx`delete from core.sessions`; continue; }
      if (ausgeschlossen.has(tab.name)) continue;
      await tx.unsafe(`delete from ${voll(tab.name)}`);
    }
    // 2. laden: über Hilfstabelle, damit entfallene Spalten übersprungen und neue mit Standardwerten gefüllt werden
    for (const [i, tb] of m.tabellen.entries()) {
      if (!schemas.includes(tb.name.split('.')[0])) continue;
      const ziel = jetzt.find((x) => x.name === tb.name);
      const text = inhalt.daten[tb.name] ?? '';
      if (!ziel || !text) continue;
      const typ = (n: string) => ziel.spalten.find((x) => x.name === n)?.typ ?? 'text';
      const hilf = `_rs_${i}`;
      await tx.unsafe(`create temp table ${q(hilf)} (${tb.spalten.map((s) => `${q(s.name)} ${typ(s.name)}`).join(', ')}) on commit drop`);
      const w = await tx.unsafe(`copy ${q(hilf)} (${tb.spalten.map((s) => q(s.name)).join(', ')}) from stdin`).writable();
      await new Promise<void>((ok, err) => { w.on('error', err); w.on('finish', () => ok()); w.end(text); });
      const gemeinsam = tb.spalten.map((s) => s.name).filter((n) => ziel.spalten.some((x) => x.name === n));
      const [id] = await tx`select exists (select 1 from pg_attribute where attrelid = ${tb.name}::regclass and attidentity = 'a' and attnum > 0) as immer`;
      const r = await tx.unsafe(`insert into ${voll(tb.name)} (${gemeinsam.map(q).join(', ')}) ${id?.immer ? 'overriding system value ' : ''}select ${gemeinsam.map(q).join(', ')} from ${q(hilf)}`);
      zeilen += r.count;
    }
    // 3. Zähler (serial/identity) hinter den höchsten Wert setzen
    const seqs = await tx`
      select s.oid::regclass::text as seq, t.oid::regclass::text as tab, a.attname as spalte
        from pg_class s
        join pg_depend d on d.objid = s.oid and d.classid = 'pg_class'::regclass and d.refclassid = 'pg_class'::regclass and d.deptype in ('a', 'i')
        join pg_class t on t.oid = d.refobjid
        join pg_namespace n on n.oid = t.relnamespace
        join pg_attribute a on a.attrelid = t.oid and a.attnum = d.refobjsubid
       where s.relkind = 'S' and n.nspname = any(${schemas})`;
    for (const s of seqs) {
      await tx.unsafe(`select setval('${s.seq.replace(/'/g, "''")}', coalesce((select max(${q(s.spalte)}) from ${s.tab}), 0) + 1, false)`);
    }
    // 4. Fremdschlüssel prüfen (Trigger waren aus)
    const fk = await fremdschluesselPruefen(tx, schemas);
    if (fk.fehler.length) throw new BusinessError(`Rücksicherung abgebrochen – die Daten passen nicht zusammen:\n${fk.fehler.join('\n')}\nTipp: zusammengehörige Bereiche gemeinsam zurücksichern (z. B. Basis und Fachbereiche).`);
    hinweise.push(...fk.bereinigt);
  });

  for (const s of pr.schemas.filter((x) => schemas.includes(x.schema) && x.status === 'aelter')) hinweise.push(`${s.text}: ${s.hinweise[0]}`);
  return {
    text: `Rücksicherung abgeschlossen: ${schemas.map(schemaText).join(', ')} – ${zeilen.toLocaleString('de-DE')} Datensätze aus der Sicherung vom ${new Date(m.erstellt).toLocaleString('de-DE', { timeZone: 'Europe/Berlin' })}.`,
    hinweise,
    abgemeldet: schemas.includes('core'),
  };
}
