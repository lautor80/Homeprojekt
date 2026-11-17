import { BusinessError } from '../../../../server/src/errors.js';
import { rechnungPdf } from './rechnung.js';
import { lieferscheinPdf, transportauftragPdf } from './dokumente.js';

export type PdfArt = 'T' | 'L' | 'R';

/**
 * PDF eines Dokuments wie `GET /pdf/:art/:id` – gemeinsam für die Route und den Sammelversand.
 *  - T: Transportauftrag; `id` = Auftragsnummer (Fahrt 1) oder „Auftrag-Fahrt“ (z. B. 2026_1260-2)
 *  - L: Lieferschein; `id` = Auftragsnummer
 *  - R: Rechnung (ZUGFeRD/Factur-X, PDF/A-3); `id` = Rechnungsnummer (faktura)
 */
export async function dokumentPdf(art: PdfArt, id: string): Promise<{ pdf: Buffer; name: string }> {
  if (art === 'R') {
    const r = await rechnungPdf(id);
    if (!r) throw new BusinessError(`Rechnung ${id} nicht gefunden.`, 404);
    return { pdf: r.pdf, name: r.filename };
  }
  if (art === 'L') return { pdf: await lieferscheinPdf(id), name: `Lieferschein_${id}.pdf` };
  return { pdf: await transportauftragPdf(id), name: `Transportauftrag_${id}.pdf` };
}
