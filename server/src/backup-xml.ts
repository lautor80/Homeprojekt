import zlib from 'node:zlib';
import { BusinessError } from './errors.js';

/**
 * Sicherung als ZIP mit XML-Dateien – lesbar, mit Standardwerkzeugen prüfbar und nach Bearbeitung wieder importierbar.
 *
 *   manifest.xml                    Zeitpunkt, Ersteller, Bereiche, Migrationsstand, Tabellenliste
 *   LIESMICH.txt                    Aufbau und Hinweise
 *   daten/<schema>/<tabelle>.xml    je Tabelle Spalten und Zeilen
 *
 * Tabellendatei:
 *   <tabelle name="tco.mitglieder" zeilen="2">
 *     <spalten><spalte name="adrnr" typ="text"/>…</spalten>
 *     <zeile><wert spalte="adrnr">0000000901</wert><wert spalte="austritt" null="1"/>…</zeile>
 *   </tabelle>
 * Werte stehen in der Textdarstellung von PostgreSQL (Datum JJJJ-MM-TT, Wahrheitswerte t/f, JSON als Text).
 * Werte mit in XML unzulässigen Steuerzeichen werden Base64-kodiert (b64="1").
 *
 * ZIP: eigene, abhängigkeitsfreie Umsetzung (Deflate, UTF-8-Dateinamen, ohne ZIP64 – bis 4 GB).
 */

// ---------------------------------------------------------------------------
// ZIP
// ---------------------------------------------------------------------------
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
export function crc32(b: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosZeit(d: Date) {
  return {
    zeit: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    datum: ((Math.max(d.getFullYear(), 1980) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

export function zipSchreiben(dateien: { name: string; daten: Buffer }[], zeitpunkt = new Date()): Buffer {
  const lokal: Buffer[] = [];
  const zentral: Buffer[] = [];
  let offset = 0;
  const { zeit, datum } = dosZeit(zeitpunkt);
  for (const f of dateien) {
    const name = Buffer.from(f.name, 'utf8');
    const komprimiert = zlib.deflateRawSync(f.daten, { level: 6 });
    const crc = crc32(f.daten);
    const kopf = Buffer.alloc(30);
    kopf.writeUInt32LE(0x04034b50, 0);
    kopf.writeUInt16LE(20, 4);
    kopf.writeUInt16LE(0x0800, 6); // UTF-8
    kopf.writeUInt16LE(8, 8); // Deflate
    kopf.writeUInt16LE(zeit, 10);
    kopf.writeUInt16LE(datum, 12);
    kopf.writeUInt32LE(crc, 14);
    kopf.writeUInt32LE(komprimiert.length, 18);
    kopf.writeUInt32LE(f.daten.length, 22);
    kopf.writeUInt16LE(name.length, 26);
    kopf.writeUInt16LE(0, 28);
    lokal.push(kopf, name, komprimiert);
    const z = Buffer.alloc(46);
    z.writeUInt32LE(0x02014b50, 0);
    z.writeUInt16LE(20, 4);
    z.writeUInt16LE(20, 6);
    z.writeUInt16LE(0x0800, 8);
    z.writeUInt16LE(8, 10);
    z.writeUInt16LE(zeit, 12);
    z.writeUInt16LE(datum, 14);
    z.writeUInt32LE(crc, 16);
    z.writeUInt32LE(komprimiert.length, 20);
    z.writeUInt32LE(f.daten.length, 24);
    z.writeUInt16LE(name.length, 28);
    z.writeUInt32LE(offset, 42);
    zentral.push(z, name);
    offset += 30 + name.length + komprimiert.length;
  }
  const zentralBuf = Buffer.concat(zentral);
  const ende = Buffer.alloc(22);
  ende.writeUInt32LE(0x06054b50, 0);
  ende.writeUInt16LE(dateien.length, 8);
  ende.writeUInt16LE(dateien.length, 10);
  ende.writeUInt32LE(zentralBuf.length, 12);
  ende.writeUInt32LE(offset, 16);
  return Buffer.concat([...lokal, zentralBuf, ende]);
}

export const istZip = (b: Buffer) => b.length > 4 && b.readUInt32LE(0) === 0x04034b50;

export function zipLesen(b: Buffer): Map<string, Buffer> {
  let e = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65535); i--) {
    if (b.readUInt32LE(i) === 0x06054b50) { e = i; break; }
  }
  if (e < 0) throw new BusinessError('Die ZIP-Datei ist unvollständig oder beschädigt.');
  const anzahl = b.readUInt16LE(e + 10);
  let p = b.readUInt32LE(e + 16);
  if (anzahl === 0xffff || p === 0xffffffff) throw new BusinessError('ZIP64-Archive werden nicht unterstützt.');
  const out = new Map<string, Buffer>();
  for (let i = 0; i < anzahl; i++) {
    if (b.readUInt32LE(p) !== 0x02014b50) throw new BusinessError('Die ZIP-Datei ist beschädigt (Verzeichnis).');
    const flags = b.readUInt16LE(p + 8);
    const methode = b.readUInt16LE(p + 10);
    const crc = b.readUInt32LE(p + 16);
    const groesse = b.readUInt32LE(p + 20);
    const nl = b.readUInt16LE(p + 28);
    const xl = b.readUInt16LE(p + 30);
    const kl = b.readUInt16LE(p + 32);
    const lo = b.readUInt32LE(p + 42);
    const name = b.subarray(p + 46, p + 46 + nl).toString(flags & 0x0800 ? 'utf8' : 'latin1').replace(/\\/g, '/');
    p += 46 + nl + xl + kl;
    if (name.endsWith('/')) continue;
    if (flags & 0x1) throw new BusinessError(`„${name}“ ist im ZIP verschlüsselt – bitte ohne Passwort packen.`);
    const lnl = b.readUInt16LE(lo + 26);
    const lxl = b.readUInt16LE(lo + 28);
    const start = lo + 30 + lnl + lxl;
    const roh = b.subarray(start, start + groesse);
    let daten: Buffer;
    if (methode === 0) daten = Buffer.from(roh);
    else if (methode === 8) daten = zlib.inflateRawSync(roh);
    else throw new BusinessError(`„${name}“: Kompressionsverfahren ${methode} wird nicht unterstützt.`);
    if (crc32(daten) !== crc) throw new BusinessError(`„${name}“ im ZIP ist beschädigt (Prüfsumme).`);
    out.set(name, daten);
  }
  return out;
}

// ---------------------------------------------------------------------------
// COPY-Text ↔ Werte
// ---------------------------------------------------------------------------
export function copyZeilen(text: string): (string | null)[][] {
  if (!text) return [];
  const zeilen = text.split('\n');
  if (zeilen[zeilen.length - 1] === '') zeilen.pop();
  return zeilen.map((z) => z.split('\t').map((f) => (f === '\\N' ? null : f.replace(/\\(.)/g, (_m, c: string) => (
    { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' } as Record<string, string>)[c] ?? c))));
}
export function copyText(zeilen: (string | null)[][]): string {
  return zeilen.map((z) => z.map((v) => (v === null ? '\\N'
    : v.replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/\r/g, '\\r'))).join('\t') + '\n').join('');
}

// ---------------------------------------------------------------------------
// XML
// ---------------------------------------------------------------------------
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\r/g, '&#xD;');
const UNZULAESSIG = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
function unesc(s: string) {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_m, e: string) => (
    e === 'amp' ? '&' : e === 'lt' ? '<' : e === 'gt' ? '>' : e === 'quot' ? '"' : e === 'apos' ? "'"
      : String.fromCodePoint(e.startsWith('#x') ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))));
}
const attr = (s: string, n: string) => { const m = new RegExp(`\\b${n}="([^"]*)"`).exec(s); return m ? unesc(m[1]) : null; };

export interface XmlManifest {
  format: string; version: number; erstellt: string; von: string; notiz: string; art: string;
  schemas: string[]; migrationen: string[]; ausgeschlossen: string[]; mitAenderungsbelegen: boolean;
  tabellen: { name: string; spalten: { name: string; typ: string }[]; zeilen: number }[];
}
interface Inhalt { manifest: XmlManifest; daten: Record<string, string> }

const tabellenDatei = (name: string) => { const [s, t] = name.split('.'); return `daten/${s}/${t}.xml`; };

export function tabelleXml(name: string, spalten: { name: string; typ: string }[], text: string): string {
  const zeilen = copyZeilen(text);
  const teile: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>\n',
    `<tabelle name="${esc(name)}" zeilen="${zeilen.length}">\n  <spalten>\n`,
    ...spalten.map((s) => `    <spalte name="${esc(s.name)}" typ="${esc(s.typ)}"/>\n`),
    '  </spalten>\n',
  ];
  for (const z of zeilen) {
    teile.push('  <zeile>');
    z.forEach((v, i) => {
      const n = esc(spalten[i]?.name ?? `spalte${i + 1}`);
      if (v === null) teile.push(`<wert spalte="${n}" null="1"/>`);
      else if (UNZULAESSIG.test(v)) teile.push(`<wert spalte="${n}" b64="1">${Buffer.from(v, 'utf8').toString('base64')}</wert>`);
      else teile.push(`<wert spalte="${n}">${esc(v)}</wert>`);
    });
    teile.push('</zeile>\n');
  }
  teile.push('</tabelle>\n');
  return teile.join('');
}

export function tabelleAusXml(xml: string, datei: string): { name: string; spalten: { name: string; typ: string }[]; text: string; zeilen: number } {
  const kopf = /<tabelle\b([^>]*)>/.exec(xml);
  const name = kopf ? attr(kopf[1], 'name') : null;
  if (!name) throw new BusinessError(`${datei}: Element <tabelle name="…"> fehlt.`);
  const spalten = [...xml.matchAll(/<spalte\b([^>]*?)\/?>/g)].map((m) => ({ name: attr(m[1], 'name') ?? '', typ: attr(m[1], 'typ') ?? 'text' }));
  if (!spalten.length || spalten.some((s) => !s.name)) throw new BusinessError(`${datei}: Spaltenliste fehlt oder ist unvollständig.`);
  const index = new Map(spalten.map((s, i) => [s.name, i]));
  const zeilen: (string | null)[][] = [];
  for (const z of xml.matchAll(/<zeile\b[^>]*>([\s\S]*?)<\/zeile>|<zeile\b[^>]*\/>/g)) {
    const werte: (string | null)[] = spalten.map(() => null);
    for (const w of (z[1] ?? '').matchAll(/<wert\b([^>]*?)(?:\/>|>([\s\S]*?)<\/wert>)/g)) {
      const sp = attr(w[1], 'spalte');
      const i = sp === null ? undefined : index.get(sp);
      if (i === undefined) throw new BusinessError(`${datei}: Wert für unbekannte Spalte „${sp ?? '?'}“.`);
      if (attr(w[1], 'null') === '1') { werte[i] = null; continue; }
      const roh = w[2] ?? '';
      werte[i] = attr(w[1], 'b64') === '1' ? Buffer.from(roh.trim(), 'base64').toString('utf8') : unesc(roh);
    }
    zeilen.push(werte);
  }
  return { name, spalten, text: copyText(zeilen), zeilen: zeilen.length };
}

export function manifestXml(m: XmlManifest): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<sicherung format="${esc(m.format)}" version="${m.version}" erstellt="${esc(m.erstellt)}" von="${esc(m.von)}" art="${esc(m.art)}" aenderungsbelege="${m.mitAenderungsbelegen ? '1' : '0'}">`,
    `  <notiz>${esc(m.notiz)}</notiz>`,
    '  <bereiche>', ...m.schemas.map((s) => `    <bereich>${esc(s)}</bereich>`), '  </bereiche>',
    '  <migrationen>', ...m.migrationen.map((s) => `    <migration>${esc(s)}</migration>`), '  </migrationen>',
    '  <ausgeschlossen>', ...m.ausgeschlossen.map((s) => `    <tabelle>${esc(s)}</tabelle>`), '  </ausgeschlossen>',
    '  <tabellen>', ...m.tabellen.map((t) => `    <tabelle name="${esc(t.name)}" zeilen="${t.zeilen}" datei="${esc(tabellenDatei(t.name))}"/>`), '  </tabellen>',
    '</sicherung>', '',
  ].join('\n');
}

const LIESMICH = `Portal-Sicherung als XML (ZIP)

manifest.xml                  Zeitpunkt, Ersteller, Bereiche, Datenbankstand (Migrationen), Tabellenliste
daten/<bereich>/<tabelle>.xml je Tabelle: Spalten (Name, Datentyp) und Zeilen

Werte stehen in der Textdarstellung von PostgreSQL:
  Datum JJJJ-MM-TT, Zeitstempel mit Zeitzone, Wahrheitswerte t/f, Zahlen mit Punkt, JSON als Text.
  null="1" = kein Wert; b64="1" = Base64-kodiert (Steuerzeichen).

Import: Administration -> Sicherung -> „Sicherung hochladen“ (diese ZIP-Datei), danach prüfen und zurücksichern.
Bearbeitete Dateien bleiben importierbar, solange Spaltennamen und Wertformate erhalten bleiben.
Achtung: Die Datei enthält alle Daten unverschlüsselt (auch Kennwort-Hashes und Bankdaten) – sicher aufbewahren.
`;

export function inhaltZuZip(inhalt: Inhalt): Buffer {
  const m = inhalt.manifest;
  const dateien = [
    { name: 'manifest.xml', daten: Buffer.from(manifestXml(m), 'utf8') },
    { name: 'LIESMICH.txt', daten: Buffer.from(LIESMICH, 'utf8') },
    ...m.tabellen.map((t) => ({ name: tabellenDatei(t.name), daten: Buffer.from(tabelleXml(t.name, t.spalten, inhalt.daten[t.name] ?? ''), 'utf8') })),
  ];
  return zipSchreiben(dateien, new Date(m.erstellt));
}

export function zipZuInhalt(b: Buffer): Inhalt {
  const dateien = zipLesen(b);
  // Manifest auch in einem Unterordner akzeptieren (z. B. nach erneutem Packen)
  const mName = [...dateien.keys()].find((n) => n === 'manifest.xml' || n.endsWith('/manifest.xml'));
  if (!mName) throw new BusinessError('Im ZIP fehlt die Datei manifest.xml – keine Portal-Sicherung.');
  const basis = mName.slice(0, mName.length - 'manifest.xml'.length);
  const mx = dateien.get(mName)!.toString('utf8');
  const kopf = /<sicherung\b([^>]*)>/.exec(mx);
  if (!kopf) throw new BusinessError('manifest.xml: Element <sicherung> fehlt.');
  const liste = (tag: string, el: string) => {
    const block = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(mx)?.[1] ?? '';
    return [...block.matchAll(new RegExp(`<${el}>([^<]*)</${el}>`, 'g'))].map((x) => unesc(x[1]).trim()).filter(Boolean);
  };
  const tabBlock = /<tabellen>([\s\S]*?)<\/tabellen>/.exec(mx)?.[1] ?? '';
  const eintraege = [...tabBlock.matchAll(/<tabelle\b([^>]*?)\/?>/g)].map((x) => ({ name: attr(x[1], 'name') ?? '', datei: attr(x[1], 'datei') ?? '' }));
  const manifest: XmlManifest = {
    format: attr(kopf[1], 'format') ?? '', version: Number(attr(kopf[1], 'version') ?? 0), erstellt: attr(kopf[1], 'erstellt') ?? new Date().toISOString(),
    von: attr(kopf[1], 'von') ?? '', art: attr(kopf[1], 'art') ?? 'manuell', mitAenderungsbelegen: attr(kopf[1], 'aenderungsbelege') !== '0',
    notiz: unesc(/<notiz>([\s\S]*?)<\/notiz>/.exec(mx)?.[1] ?? ''),
    schemas: liste('bereiche', 'bereich'), migrationen: liste('migrationen', 'migration'), ausgeschlossen: liste('ausgeschlossen', 'tabelle'),
    tabellen: [],
  };
  const daten: Record<string, string> = {};
  for (const e of eintraege) {
    const pfad = basis + (e.datei || tabellenDatei(e.name));
    const x = dateien.get(pfad);
    if (!x) throw new BusinessError(`Im ZIP fehlt die Tabellendatei ${pfad} (laut manifest.xml).`);
    const t = tabelleAusXml(x.toString('utf8'), pfad);
    if (e.name && t.name !== e.name) throw new BusinessError(`${pfad}: enthält Tabelle ${t.name}, erwartet ${e.name}.`);
    daten[t.name] = t.text;
    manifest.tabellen.push({ name: t.name, spalten: t.spalten, zeilen: t.zeilen });
  }
  return { manifest, daten };
}
