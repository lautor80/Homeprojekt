import zlib from 'node:zlib';

/**
 * ZIP-Archiv entpacken (ohne Zusatzpaket): liest das zentrale Verzeichnis,
 * unterstützt „stored“ und „deflate“ (wie cl_abap_zip, Windows, Excel).
 */
export function istZip(buf: Buffer): boolean {
  return buf.length > 22 && buf.readUInt32LE(0) === 0x04034b50;
}

export function entpacken(buf: Buffer): { name: string; inhalt: Buffer }[] {
  // Ende des zentralen Verzeichnisses suchen (max. 64 KB Kommentar)
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Keine gültige ZIP-Datei');
  const anzahl = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out: { name: string; inhalt: Buffer }[] = [];
  for (let i = 0; i < anzahl; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('ZIP-Verzeichnis beschädigt');
    const methode = buf.readUInt16LE(p + 10);
    const groesse = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const lokal = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    p += 46 + nlen + xlen + clen;
    if (name.endsWith('/')) continue;
    const lnlen = buf.readUInt16LE(lokal + 26);
    const lxlen = buf.readUInt16LE(lokal + 28);
    const start = lokal + 30 + lnlen + lxlen;
    const daten = buf.subarray(start, start + groesse);
    if (methode === 0) out.push({ name, inhalt: Buffer.from(daten) });
    else if (methode === 8) out.push({ name, inhalt: zlib.inflateRawSync(daten) });
    else throw new Error(`ZIP-Eintrag ${name}: Kompressionsverfahren ${methode} nicht unterstützt`);
  }
  return out;
}

/**
 * ZIP-Archiv schreiben (ohne Zusatzpaket): je Eintrag „deflate“ (bzw. „stored“, wenn das nicht kleiner wird),
 * Reihenfolge wie übergeben – bei Office-Dateien gehört `[Content_Types].xml` an den Anfang.
 */
export function packen(eintraege: { name: string; inhalt: Buffer }[]): Buffer {
  const lokal: Buffer[] = [];
  const zentral: Buffer[] = [];
  let offset = 0;
  // fester Zeitstempel 01.01.2020 00:00 (DOS-Format) – reproduzierbare Dateien
  const zeit = 0, datum = ((2020 - 1980) << 9) | (1 << 5) | 1;
  for (const e of eintraege) {
    const name = Buffer.from(e.name, 'utf8');
    const crc = zlib.crc32(e.inhalt) >>> 0;
    const def = zlib.deflateRawSync(e.inhalt);
    const methode = def.length < e.inhalt.length ? 8 : 0;
    const daten = methode === 8 ? def : e.inhalt;
    const kopf = Buffer.alloc(30);
    kopf.writeUInt32LE(0x04034b50, 0); kopf.writeUInt16LE(20, 4); kopf.writeUInt16LE(0x0800, 6); kopf.writeUInt16LE(methode, 8);
    kopf.writeUInt16LE(zeit, 10); kopf.writeUInt16LE(datum, 12); kopf.writeUInt32LE(crc, 14);
    kopf.writeUInt32LE(daten.length, 18); kopf.writeUInt32LE(e.inhalt.length, 22); kopf.writeUInt16LE(name.length, 26); kopf.writeUInt16LE(0, 28);
    lokal.push(kopf, name, daten);
    const z = Buffer.alloc(46);
    z.writeUInt32LE(0x02014b50, 0); z.writeUInt16LE(20, 4); z.writeUInt16LE(20, 6); z.writeUInt16LE(0x0800, 8); z.writeUInt16LE(methode, 10);
    z.writeUInt16LE(zeit, 12); z.writeUInt16LE(datum, 14); z.writeUInt32LE(crc, 16); z.writeUInt32LE(daten.length, 20); z.writeUInt32LE(e.inhalt.length, 24);
    z.writeUInt16LE(name.length, 28); z.writeUInt32LE(offset, 42);
    zentral.push(z, name);
    offset += 30 + name.length + daten.length;
  }
  const zgr = zentral.reduce((s, b) => s + b.length, 0);
  const ende = Buffer.alloc(22);
  ende.writeUInt32LE(0x06054b50, 0); ende.writeUInt16LE(eintraege.length, 8); ende.writeUInt16LE(eintraege.length, 10);
  ende.writeUInt32LE(zgr, 12); ende.writeUInt32LE(offset, 16);
  return Buffer.concat([...lokal, ...zentral, ende]);
}
