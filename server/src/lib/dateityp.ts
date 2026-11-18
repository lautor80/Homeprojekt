/**
 * Dateityp (MIME) einer empfangenen Datei zuverlässig bestimmen – reine Logik, ohne Abhängigkeiten.
 *
 * Mailserver und Microsoft Graph liefern Anhänge oft als „application/octet-stream“ (z. B. „…-POD-….PDF“ von Speditionen).
 * Mit diesem Typ zeigt kein Browser die Datei an: die PDF-Vorschau bleibt leer und lädt stattdessen eine namenlose Datei
 * herunter. Deshalb gilt: Inhalt (Signatur am Dateianfang) vor angegebenem Typ vor Dateiendung.
 */

/** Typen, die nichts über den Inhalt sagen */
const NICHTSSAGEND = /^(application\/(octet-stream|x-download|force-download|download|binary|unknown|x-unknown)|binary\/octet-stream|unknown\/unknown)?$/i;

const ENDUNG: Record<string, string> = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  tif: 'image/tiff', tiff: 'image/tiff', bmp: 'image/bmp', heic: 'image/heic', txt: 'text/plain', csv: 'text/csv',
  xml: 'application/xml', zip: 'application/zip', eml: 'message/rfc822', msg: 'application/vnd.ms-outlook',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

const beginnt = (b: Uint8Array, s: number[], ab = 0) => b.length >= ab + s.length && s.every((x, i) => b[ab + i] === x);
const text = (s: string) => [...s].map((c) => c.charCodeAt(0));

/** Signatur am Dateianfang; null = unbekannt */
export function typAusInhalt(b: Uint8Array): string | null {
  // PDF: „%PDF-“ darf laut Norm innerhalb der ersten 1024 Bytes stehen (z. B. nach einem Vorspann von Scannern)
  const kopf = b.subarray(0, 1024);
  for (let i = 0; i + 5 <= kopf.length; i++) if (beginnt(kopf, text('%PDF-'), i)) return 'application/pdf';
  if (beginnt(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (beginnt(b, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (beginnt(b, text('GIF87a')) || beginnt(b, text('GIF89a'))) return 'image/gif';
  if (beginnt(b, text('RIFF')) && beginnt(b, text('WEBP'), 8)) return 'image/webp';
  if (beginnt(b, [0x49, 0x49, 0x2a, 0x00]) || beginnt(b, [0x4d, 0x4d, 0x00, 0x2a])) return 'image/tiff';
  return null;
}

export const typAusName = (name: string): string | null => ENDUNG[(/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? '').toLowerCase()] ?? null;

/** Bester Typ: Inhalt, sonst angegebener (wenn aussagekräftig), sonst Dateiendung, sonst application/octet-stream */
export function dateityp(name: string, angegeben: string | null | undefined, daten?: Uint8Array | null): string {
  const inhalt = daten ? typAusInhalt(daten) : null;
  if (inhalt) return inhalt;
  const a = (angegeben ?? '').split(';')[0].trim().toLowerCase();
  if (!NICHTSSAGEND.test(a)) return a;
  return typAusName(name) ?? 'application/octet-stream';
}
