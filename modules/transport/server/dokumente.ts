import { BusinessError } from '../../../server/src/errors.js';
import { Paperless, PaperlessError, paperlessKonfiguriert } from '../../../server/src/lib/paperless.js';
import type { Firma } from './data.js';
import { kontextAblegen } from '../../../server/src/lib/paperless-mapping.js';
import { K } from './paperless-kontexte.js';

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
export const endung = (n: string) => (/\.([a-z0-9]+)$/i.exec(n)?.[1] ?? '').toLowerCase();
/** MIME-Typ nach Dateiendung (E-Mail-Anhänge, Ablage) */
export const mimeTyp = (n: string) => MIME[endung(n)] ?? ({ xml: 'application/xml', zip: 'application/zip' } as Record<string, string>)[endung(n)] ?? 'application/octet-stream';

export function paperlessFirma(f: Firma): Paperless {
  if (!paperlessKonfiguriert({ url: f.paperless_url, token: f.paperless_token })) {
    throw new BusinessError('Paperless ist nicht eingerichtet (Administration → Schnittstellen: Adresse und API-Token).');
  }
  return new Paperless({ url: f.paperless_url, token: f.paperless_token });
}

export async function dokumentAblegen(f: Firma, a: { auftragsnr: string; kunde: string | null; unternehmer?: string | null; kennzeichen?: string | null; ordernummer?: string | null; datum: string; benutzer?: string }, datei: string, inhalt: string) {
  const name = datei.split(/[\\/]/).pop()!.trim().slice(0, 150);
  const e = endung(name);
  if (!DATEITYPEN.includes(e)) throw new BusinessError(`Dateityp „${e || '?'}“ wird nicht unterstützt (erlaubt: ${DATEITYPEN.join(', ')}).`);
  const daten = Buffer.from(inhalt.replace(/^data:[^,]*,/, ''), 'base64');
  if (!daten.length) throw new BusinessError('Die Datei ist leer.');
  if (daten.length > 50 * 1024 * 1024) throw new BusinessError('Die Datei ist größer als 50 MB.');
  const pl = paperlessFirma(f);
  try {
    // Felder laut zentraler Paperless-Zuordnung (Kontext „Dokument zum Auftrag“)
    const r = await kontextAblegen(pl, K.auftragDokument, 'transport', {
      auftragsnr: a.auftragsnr, kunde: a.kunde ?? '', unternehmer: a.unternehmer ?? '', kennzeichen: a.kennzeichen ?? '', ordernummer: a.ordernummer ?? '',
      datei: name, heute: a.datum, benutzer: a.benutzer ?? '',
    }, daten, name, { mime: MIME[e] ?? 'application/octet-stream', benutzer: a.benutzer });
    if (!r.id) throw new BusinessError('Paperless verarbeitet die Datei noch – bitte in einer Minute die Dokumentliste aktualisieren (Tag „Auftrag …“).');
    return { id: r.id, titel: r.zuordnung.title || name, datei: name, warnungen: r.warnungen };
  } catch (x) {
    if (x instanceof PaperlessError) throw new BusinessError(x.message);
    throw x;
  }
}
