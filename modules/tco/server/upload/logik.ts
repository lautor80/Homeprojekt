import { BusinessError } from '../../../../server/src/errors.js';
import { PaperlessError } from '../../../../server/src/lib/paperless.js';
import { heute } from '../format.js';
import { paperless, plAktiv, type Verein } from '../verein.js';

/**
 * Dokumenten-Upload – Port von Z2UI5_CL_TCO_UPLOAD_MULTI / Z2UI5_CL_TCO_FILEUPLOAD.
 * Mehrere Belege werden mit gemeinsamen Metadaten (Dokumenttyp, Korrespondent, Datum, Tags)
 * und eigenem Titel nach Paperless übertragen; je Datei entsteht eine Statuszeile.
 */

/** Dateitypen wie das UploadSet in SAP (fileTypes) */
export const DATEITYPEN = ['pdf', 'png', 'jpg', 'jpeg', 'csv', 'txt', 'doc', 'docx', 'xls', 'xlsx'] as const;
/** Größenbegrenzung wie maxFileSize = 50 (MB) */
export const MAX_BYTES = 50 * 1024 * 1024;

const MIME: Record<string, string> = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', csv: 'text/csv', txt: 'text/plain',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

export const endung = (name: string) => (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? '').toLowerCase();

/** SIZE_FORMAT: 512 B, 12,3 KB, 1,2 MB */
export function groesseText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} KB`;
  return `${(bytes / 1048576).toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} MB`;
}

/**
 * DETECT_FILE_TARGET: Vorschlag für den Bereich aus dem Dateinamen – wird in der Statusliste
 * als Hinweis gezeigt (CSV-Dateien gehören in die jeweiligen Apps, nicht nach Paperless).
 */
export function zielBereich(name: string): string {
  const n = name.toLowerCase();
  const e = endung(n);
  if (e === 'csv') {
    if (n.includes('jugend')) return 'Jugendabrechnung';
    if (n.includes('mitglied')) return 'Mitglieder';
    if (n.includes('halle')) return 'Hallenabrechnung';
    if (n.includes('clubhaus')) return 'Clubhausabrechnung';
    return 'CSV (Bereich unklar)';
  }
  if (e === 'pdf' || e === 'jpg' || e === 'jpeg' || e === 'png') return 'FI Belege';
  return 'Unbekannt';
}

/** Daten-URL oder Base64 → Buffer und MIME-Typ */
export function dekodieren(datei: string, inhalt: string): { daten: Buffer; mime: string } {
  const m = /^data:([^;,]*)(;base64)?,/.exec(inhalt);
  const daten = Buffer.from(inhalt.replace(/^data:[^,]*,/, ''), 'base64');
  const mime = (m?.[1] && m[1] !== 'application/octet-stream' ? m[1] : MIME[endung(datei)]) || 'application/octet-stream';
  return { daten, mime };
}

export function dateiPruefen(datei: string, bytes: number) {
  const e = endung(datei);
  if (!(DATEITYPEN as readonly string[]).includes(e)) throw new BusinessError(`Dateityp „${e || '?'}“ wird nicht unterstützt (erlaubt: ${DATEITYPEN.join(', ')}).`);
  if (!bytes) throw new BusinessError('Die Datei ist leer.');
  if (bytes > MAX_BYTES) throw new BusinessError(`Die Datei ist größer als 50 MB (${groesseText(bytes)}).`);
  if (datei.length > 100) throw new BusinessError('Der Dateiname darf höchstens 100 Zeichen lang sein.');
}

export interface Meta {
  titel: string; datum: string; doktyp: number | null; korrespondent: number | null; korrespondentNeu: string;
  tags: number[]; tagsNeu: string[]; speicherpfad: number | null; notiz: string;
}
export interface UploadErgebnis { id: number | null; text: string; state: 'Positive' | 'Critical' | 'Negative' }

/** Stammdaten aus Paperless für die Auswahlfelder */
export async function stammLesen(v: Verein) {
  if (!plAktiv(v)) return { paperless: false, dokumenttypen: [], korrespondenten: [], tags: [], speicherpfade: [], heute: heute() };
  const pl = paperless(v);
  const sort = (l: { id: number; name: string }[]) => l.map((x) => ({ id: x.id, name: x.name })).sort((a, b) => a.name.localeCompare(b.name, 'de'));
  return {
    paperless: true, dokumenttypen: sort(await pl.dokumenttypen()), korrespondenten: sort(await pl.korrespondenten()),
    tags: sort(await pl.tags()), speicherpfade: sort(await pl.speicherpfade()), heute: heute(),
  };
}

/** Eine Datei nach Paperless übertragen; neue Korrespondenten/Tags werden angelegt */
export async function hochladen(v: Verein, datei: string, inhalt: string, m: Meta, benutzer: string): Promise<UploadErgebnis> {
  if (!plAktiv(v)) throw new BusinessError('Paperless ist nicht eingerichtet (Stammdaten → Anbindungen).');
  const name = datei.split(/[\\/]/).pop()!.trim();
  const { daten, mime } = dekodieren(name, inhalt);
  dateiPruefen(name, daten.length);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(m.datum)) throw new BusinessError('Bitte ein Dokumentdatum angeben.');
  const pl = paperless(v);
  let korr = m.korrespondent;
  if (!korr && m.korrespondentNeu.trim()) korr = await pl.korrespondent(m.korrespondentNeu);
  const tags = [...m.tags];
  for (const t of m.tagsNeu) { const id = await pl.tag(t); if (id && !tags.includes(id)) tags.push(id); }
  const titel = m.titel.trim() || name.replace(/\.[^.]+$/, '');
  try {
    const task = await pl.upload(daten, name, {
      title: titel, created: m.datum, correspondent: korr ?? undefined, documentType: m.doktyp ?? undefined,
      storagePath: m.speicherpfad ?? undefined, tags, mime,
    });
    const id = await pl.warteAufDokument(task, 30);
    if (id && m.notiz.trim()) await pl.notizAnlegen(id, `${m.notiz.trim()} (${benutzer}, Vereinsportal)`).catch(() => undefined);
    return id
      ? { id, text: `Abgelegt als Dokument ${id}`, state: 'Positive' }
      : { id: null, text: 'Übertragen – Paperless verarbeitet die Datei noch', state: 'Critical' };
  } catch (e) {
    if (e instanceof PaperlessError) return { id: null, text: e.message, state: 'Negative' };
    throw e;
  }
}
