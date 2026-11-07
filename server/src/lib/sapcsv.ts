/**
 * CSV-Dateien aus SAP (CL_ICF_CSV, SE16-Export, Excel) lesen.
 *  - Kodierung: UTF-8 (mit/ohne BOM), sonst Windows-1252
 *  - Trennzeichen aus der Kopfzeile (; Tab ,)
 *  - Felder in "…" dürfen Trennzeichen und Zeilenumbrüche enthalten, "" = "
 *  - Werte im SAP-Format: Datum JJJJMMTT / 00000000, Uhrzeit HHMMSS,
 *    Beträge 1.234,56 oder 1234.56 mit Minus vorne oder hinten, Kennzeichen X
 */

export function dekodieren(buf: Buffer): string {
  let b = buf;
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) b = b.subarray(3);
  let s: string;
  try {
    s = new TextDecoder('utf-8', { fatal: true }).decode(b);
  } catch {
    s = new TextDecoder('windows-1252').decode(b);
  }
  return s.replace(/^﻿/, '');
}

export function trennzeichen(kopfzeile: string): string {
  const z = { ';': 0, '\t': 0, ',': 0 } as Record<string, number>;
  for (const c of kopfzeile) if (c in z) z[c]++;
  if (z[';'] >= z['\t'] && z[';'] >= z[',']) return z[';'] ? ';' : z['\t'] ? '\t' : ',';
  return z['\t'] >= z[','] ? '\t' : ',';
}

/** ganze Datei nach RFC 4180 zerlegen */
export function csvParse(text: string, sep?: string): string[][] {
  const t = text.replace(/\r\n?/g, '\n');
  const d = sep ?? trennzeichen(t.slice(0, t.indexOf('\n') < 0 ? t.length : t.indexOf('\n')));
  const rows: string[][] = [];
  let row: string[] = [];
  let f = '';
  let q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) {
      if (c === '"') {
        if (t[i + 1] === '"') { f += '"'; i++; } else q = false;
      } else f += c;
      continue;
    }
    if (c === '"' && f === '') q = true;
    else if (c === d) { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim() !== ''));
}

export function sapDatum(v: string): string | null {
  const s = v.trim();
  if (!s || /^0+$/.test(s)) return null;
  let m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (m) return m[1] === '9999' && m[2] === '12' ? `9999-12-31` : `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})\.(\d{1,2})\.(\d{2,4})/.exec(s);
  if (m) {
    const j = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${j}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  throw new Error(`Datum „${s}“`);
}

export function sapZeit(v: string): string | null {
  const s = v.trim();
  if (!s) return null;
  let m = /^(\d{2})(\d{2})(\d{2})?$/.exec(s);
  if (m) return `${m[1]}:${m[2]}:${m[3] ?? '00'}`;
  m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(s);
  if (m) return `${m[1].padStart(2, '0')}:${m[2]}:${m[3] ?? '00'}`;
  throw new Error(`Uhrzeit „${s}“`);
}

export function sapBetrag(v: string): number | null {
  let t = v.trim().replace(/\s/g, '');
  if (!t) return null;
  let neg = false;
  if (t.endsWith('-')) { neg = true; t = t.slice(0, -1); }
  if (t.startsWith('-')) { neg = true; t = t.slice(1); }
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  else if ((t.match(/\./g) ?? []).length > 1) t = t.replace(/\./g, '');
  if (!/^\d*(\.\d+)?$/.test(t) || t === '') throw new Error(`Zahl „${v.trim()}“`);
  return (neg ? -1 : 1) * Number(t);
}

export function sapBool(v: string): boolean {
  return ['X', 'TRUE', '1', 'JA', 'J', 'Y'].includes(v.trim().toUpperCase());
}
