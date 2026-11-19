import { BusinessError } from '../../../server/src/errors.js';
import { PaperlessError } from '../../../server/src/lib/paperless.js';
import { kontextAblegen, kontextAktualisieren } from '../../../server/src/lib/paperless-mapping.js';
import { fakturaAuftraege, type Firma } from './data.js';
import { paperlessFirma } from './dokumente.js';
import { K } from './paperless-kontexte.js';
import { auftragFeldSichern } from './paperless-auftrag.js';
import { alsVersion } from './paperless-version.js';
import type { RechnungPdf } from './pdf/rechnung.js';

export interface PaperlessErgebnis {
  ok: boolean;
  message: string;
  id?: number | null;
  /** neue Dateiversion am vorhandenen Dokument statt eines neuen Dokuments */
  version?: boolean;
}

/**
 * Rechnungs-PDF (ZUGFeRD) nach Paperless – Felder laut zentraler Paperless-Zuordnung
 * (Kontext „Ausgangsrechnung“: Korrespondent = Rechnungsempfänger, Datum = Rechnungsdatum, …).
 * `vorhanden`: Die Rechnung liegt schon in Paperless → neue Dateiversion an diesem Dokument (Metadaten werden aktualisiert);
 * nur wenn das nicht geht (Dokument gelöscht, Paperless ohne Versionen), ein neues Dokument.
 */
export async function paperlessSenden(firma: Firma, r: RechnungPdf, benutzer: string, o: { vorhanden?: { docId: number; label: string } } = {}): Promise<PaperlessErgebnis> {
  if (!firma.paperless_url || !firma.paperless_token) {
    return { ok: false, message: 'Paperless ist nicht eingerichtet (Administration → Schnittstellen: Adresse und API-Token).' };
  }
  try {
    const pl = paperlessFirma(firma);
    const liste = await fakturaAuftraege(r.faktura);
    const auftraege = liste.map((a) => a.auftragsnr);
    const betrag = liste.reduce((s, a) => s + a.rgbetrag, 0);
    // Custom Field „Auftrag“ verbindet das Dokument mit dem Auftrag – anlegen, falls es in Paperless noch fehlt
    await auftragFeldSichern(pl).catch(() => undefined);
    const werte = {
      faktura: r.faktura, kunde: r.kunde, datum: r.datum, betrag: Math.round(betrag * 100) / 100, titel: r.title, auftraege: auftraege.join(', '),
      datei: r.filename, heute: new Date().toISOString().slice(0, 10), benutzer,
    };
    const hinweise: string[] = [];
    if (o.vorhanden) {
      const id = o.vorhanden.docId;
      const v = await alsVersion(pl, id, r.pdf, r.filename, o.vorhanden.label);
      if (v.art !== 'neu') {
        const w = (await kontextAktualisieren(pl, K.rechnung, 'transport', id, werte, { benutzer, ohneNotiz: true })).warnungen;
        const warn = w.length ? ` Hinweis: ${w.join('; ')}` : '';
        return v.art === 'version'
          ? { ok: true, id, version: true, message: `Neue Version zu Paperless-Dokument ${id} abgelegt.${warn}` }
          : { ok: true, id, message: `Datei unverändert – Paperless-Dokument ${id} bleibt, wie es ist.${warn}` };
      }
      hinweise.push(v.grund);
    }
    const e = await kontextAblegen(pl, K.rechnung, 'transport', werte, r.pdf, r.filename, { benutzer, mime: 'application/pdf' });
    hinweise.push(...e.warnungen);
    const warn = hinweise.length ? ` Hinweis: ${hinweise.join('; ')}` : '';
    return e.id
      ? { ok: true, id: e.id, message: `In Paperless abgelegt (Dokument ${e.id}).${warn}` }
      : { ok: true, id: null, message: `An Paperless übergeben – Verarbeitung läuft noch.${warn}` };
  } catch (x) {
    if (x instanceof PaperlessError || x instanceof BusinessError) return { ok: false, message: x.message };
    return { ok: false, message: `Paperless nicht erreichbar: ${(x as Error).message}` };
  }
}
