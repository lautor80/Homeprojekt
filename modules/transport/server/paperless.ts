import { BusinessError } from '../../../server/src/errors.js';
import { PaperlessError } from '../../../server/src/lib/paperless.js';
import { kontextAblegen } from '../../../server/src/lib/paperless-mapping.js';
import { fakturaAuftraege, type Firma } from './data.js';
import { paperlessFirma } from './dokumente.js';
import { K } from './paperless-kontexte.js';
import type { RechnungPdf } from './pdf/rechnung.js';

export interface PaperlessErgebnis {
  ok: boolean;
  message: string;
  id?: number | null;
}

/**
 * Rechnungs-PDF (ZUGFeRD) nach Paperless – Felder laut zentraler Paperless-Zuordnung
 * (Kontext „Ausgangsrechnung“: Korrespondent = Rechnungsempfänger, Datum = Rechnungsdatum, …).
 */
export async function paperlessSenden(firma: Firma, r: RechnungPdf, benutzer: string): Promise<PaperlessErgebnis> {
  if (!firma.paperless_url || !firma.paperless_token) {
    return { ok: false, message: 'Paperless ist nicht eingerichtet (Administration → Schnittstellen → Anbindungen: Adresse und API-Token).' };
  }
  try {
    const pl = paperlessFirma(firma);
    const liste = await fakturaAuftraege(r.faktura);
    const auftraege = liste.map((a) => a.auftragsnr);
    const betrag = liste.reduce((s, a) => s + a.rgbetrag, 0);
    const e = await kontextAblegen(pl, K.rechnung, 'transport', {
      faktura: r.faktura, kunde: r.kunde, datum: r.datum, betrag: Math.round(betrag * 100) / 100, titel: r.title, auftraege: auftraege.join(', '),
      datei: r.filename, heute: new Date().toISOString().slice(0, 10), benutzer,
    }, r.pdf, r.filename, { benutzer, mime: 'application/pdf' });
    const warn = e.warnungen.length ? ` Hinweis: ${e.warnungen.join('; ')}` : '';
    return e.id
      ? { ok: true, id: e.id, message: `In Paperless abgelegt (Dokument ${e.id}).${warn}` }
      : { ok: true, id: null, message: `An Paperless übergeben – Verarbeitung läuft noch.${warn}` };
  } catch (x) {
    if (x instanceof PaperlessError || x instanceof BusinessError) return { ok: false, message: x.message };
    return { ok: false, message: `Paperless nicht erreichbar: ${(x as Error).message}` };
  }
}
