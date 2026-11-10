import { config } from './config.js';
import { BusinessError } from './errors.js';

export interface PdfOptions {
  /** Querformat */
  landscape?: boolean;
  /** Ränder in Zoll (Gotenberg-Standard), Default 0.4 */
  margin?: number;
}

/**
 * Wandelt HTML über Gotenberg (Chromium) in ein PDF um.
 * Layouts (Rechnung, Zeitnachweis, Lieferschein ...) sind damit normale HTML-Templates.
 */
export async function htmlToPdf(html: string, opts: PdfOptions = {}): Promise<Buffer> {
  const form = new FormData();
  form.append('files', new Blob([html], { type: 'text/html' }), 'index.html');
  const m = String(opts.margin ?? 0.4);
  for (const side of ['marginTop', 'marginBottom', 'marginLeft', 'marginRight']) form.append(side, m);
  form.append('printBackground', 'true');
  if (opts.landscape) form.append('landscape', 'true');

  let res: Response;
  try {
    res = await fetch(`${config.gotenbergUrl}/forms/chromium/convert/html`, { method: 'POST', body: form });
  } catch {
    throw new BusinessError('PDF-Dienst (Gotenberg) nicht erreichbar.', 503);
  }
  if (!res.ok) throw new BusinessError(`PDF-Erzeugung fehlgeschlagen (${res.status}).`, 502);
  return Buffer.from(await res.arrayBuffer());
}

/** Bildtypen, die sich als eigene Seite in ein PDF übernehmen lassen */
export const BILD_MIME = /^image\/(png|jpe?g|gif|webp|bmp)$/i;
export const istPdf = (mime: string | null | undefined, name: string) => /^application\/pdf$/i.test(mime ?? '') || /\.pdf$/i.test(name);

/**
 * Mehrere PDFs und Bilder in der angegebenen Reihenfolge zu einem PDF zusammenfügen (Gotenberg: Bilder per Chromium
 * als ganzseitige Seite, dann pdfengines/merge). Wirft bei verschlüsselten oder defekten PDFs.
 */
export async function pdfsZusammenfuegen(teile: { name: string; mime: string | null; daten: Buffer }[]): Promise<Buffer> {
  const pdfs: Buffer[] = [];
  for (const t of teile) {
    if (istPdf(t.mime, t.name)) pdfs.push(t.daten);
    else if (BILD_MIME.test(t.mime ?? '')) {
      const html = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0}
        img{display:block;max-width:100%;max-height:100vh;margin:0 auto;object-fit:contain}</style></head>
        <body><img src="data:${t.mime};base64,${t.daten.toString('base64')}"></body></html>`;
      pdfs.push(await htmlToPdf(html, { margin: 0.2 }));
    } else throw new BusinessError(`„${t.name}“ ist weder PDF noch Bild und lässt sich nicht zusammenfassen.`);
  }
  if (pdfs.length === 1) return pdfs[0];
  const form = new FormData();
  // Gotenberg fügt in alphanumerischer Reihenfolge der Dateinamen zusammen
  pdfs.forEach((b, i) => form.append('files', new Blob([new Uint8Array(b)], { type: 'application/pdf' }), `${String(i + 1).padStart(3, '0')}.pdf`));
  let res: Response;
  try {
    res = await fetch(`${config.gotenbergUrl}/forms/pdfengines/merge`, { method: 'POST', body: form });
  } catch {
    throw new BusinessError('PDF-Dienst (Gotenberg) nicht erreichbar.', 503);
  }
  if (!res.ok) throw new BusinessError(`Zusammenfügen fehlgeschlagen (${res.status}): ${(await res.text()).replace(/\s+/g, ' ').slice(0, 200)}`, 502);
  return Buffer.from(await res.arrayBuffer());
}

/** Minimales Escaping für Werte in HTML-Templates. */
export const esc = (v: unknown) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
