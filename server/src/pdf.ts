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

/** Minimales Escaping für Werte in HTML-Templates. */
export const esc = (v: unknown) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
