import type { Firma } from './data.js';

export interface PaperlessErgebnis {
  ok: boolean;
  message: string;
}

/**
 * PDF an Paperless-ngx übergeben (POST /api/documents/post_document/, multipart).
 * Anmeldung per API-Token (Paperless: Profil → API-Token). Paperless verarbeitet asynchron (Task-ID).
 */
export async function paperlessSenden(firma: Firma, pdf: Buffer, filename: string, title: string, created?: string): Promise<PaperlessErgebnis> {
  if (!firma.paperless_url || !firma.paperless_token) {
    return { ok: false, message: 'Paperless ist nicht eingerichtet (Stammdaten → Firmendaten: URL und API-Token).' };
  }
  const form = new FormData();
  form.append('document', new Blob([new Uint8Array(pdf)], { type: 'application/pdf' }), filename);
  form.append('title', title);
  if (created) form.append('created', created);

  let res: Response;
  try {
    res = await fetch(`${firma.paperless_url.replace(/\/+$/, '')}/api/documents/post_document/`, {
      method: 'POST',
      headers: { Authorization: `Token ${firma.paperless_token}`, Accept: 'application/json' },
      body: form,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    return { ok: false, message: `Paperless nicht erreichbar: ${(e as Error).message}` };
  }
  const body = (await res.text()).trim();
  if (res.ok) return { ok: true, message: `An Paperless übergeben (Task ${body.replace(/"/g, '')}).` };
  if (res.status === 401 || res.status === 403) return { ok: false, message: `Paperless lehnt die Anmeldung ab (${res.status}) – API-Token prüfen.` };
  return { ok: false, message: `Paperless-Fehler ${res.status}: ${body.slice(0, 300)}` };
}
