import { BusinessError } from '../../../server/src/errors.js';
import { Paperless, PaperlessError, paperlessKonfiguriert } from '../../../server/src/lib/paperless.js';
import type { Firma } from './data.js';

/**
 * Dokumente zum Auftrag: Datei (Drag & Drop, Auswahl, Screenshot) nach Paperless –
 * Titel „Auftrag 2026_0153 – Dateiname“, Korrespondent = Kunde, Tag = Auftragsnummer –
 * und Verknüpfung in transport.auftrag_dokumente.
 */
export const DATEITYPEN = ['pdf', 'png', 'jpg', 'jpeg', 'heic', 'webp', 'gif', 'tif', 'tiff', 'txt', 'csv', 'doc', 'docx', 'xls', 'xlsx', 'eml'];
const MIME: Record<string, string> = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', heic: 'image/heic', webp: 'image/webp', gif: 'image/gif',
  tif: 'image/tiff', tiff: 'image/tiff', txt: 'text/plain', csv: 'text/csv', eml: 'message/rfc822',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
const endung = (n: string) => (/\.([a-z0-9]+)$/i.exec(n)?.[1] ?? '').toLowerCase();

export function paperlessFirma(f: Firma): Paperless {
  if (!paperlessKonfiguriert({ url: f.paperless_url, token: f.paperless_token })) {
    throw new BusinessError('Paperless ist nicht eingerichtet (Stammdaten → Firmendaten: URL und API-Token).');
  }
  return new Paperless({ url: f.paperless_url, token: f.paperless_token });
}

export async function dokumentAblegen(f: Firma, a: { auftragsnr: string; kunde: string | null; datum: string }, datei: string, inhalt: string) {
  const name = datei.split(/[\\/]/).pop()!.trim().slice(0, 150);
  const e = endung(name);
  if (!DATEITYPEN.includes(e)) throw new BusinessError(`Dateityp „${e || '?'}“ wird nicht unterstützt (erlaubt: ${DATEITYPEN.join(', ')}).`);
  const daten = Buffer.from(inhalt.replace(/^data:[^,]*,/, ''), 'base64');
  if (!daten.length) throw new BusinessError('Die Datei ist leer.');
  if (daten.length > 50 * 1024 * 1024) throw new BusinessError('Die Datei ist größer als 50 MB.');
  const pl = paperlessFirma(f);
  const titel = `Auftrag ${a.auftragsnr} – ${name.replace(/\.[^.]+$/, '')}`.slice(0, 120);
  try {
    const korr = a.kunde ? await pl.korrespondent(a.kunde) : null;
    const tag = await pl.tag(`Auftrag ${a.auftragsnr}`);
    const task = await pl.upload(daten, name, {
      title: titel, created: a.datum, correspondent: korr ?? undefined, tags: tag ? [tag] : [], mime: MIME[e] ?? 'application/octet-stream',
    });
    const id = await pl.warteAufDokument(task, 30);
    if (!id) throw new BusinessError('Paperless verarbeitet die Datei noch – bitte in einer Minute die Dokumentliste aktualisieren (Tag „Auftrag …“).');
    return { id, titel, datei: name };
  } catch (x) {
    if (x instanceof PaperlessError) throw new BusinessError(x.message);
    throw x;
  }
}
