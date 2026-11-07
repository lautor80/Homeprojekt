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
