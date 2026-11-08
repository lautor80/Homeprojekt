import { PH, PH_DOKID, type KontextDef } from '../../../server/src/lib/paperless-mapping.js';

/** Ablagekontexte von Euroflex für die zentrale Paperless-Zuordnung */
const auftrag = [
  { name: 'auftragsnr', text: 'Auftragsnummer', beispiel: '2026_0153' },
  { name: 'kunde', text: 'Kunde (Korrespondent)', beispiel: 'Holz Müller GmbH' },
  { name: 'unternehmer', text: 'Unternehmer / Frachtführer', beispiel: 'Spedition Schmitt' },
  { name: 'kennzeichen', text: 'Kennzeichen', beispiel: 'WND-EF 123' },
  { name: 'ordernummer', text: 'Bestellnummer des Kunden', beispiel: 'PO-4711' },
];

export const K = {
  auftragDokument: {
    id: 'auftrag.dokument', text: 'Dokument zum Auftrag (Lieferschein, CMR, Foto …)',
    beschreibung: 'Dateien und Screenshots, die am Auftrag abgelegt werden. Die Verknüpfung zum Auftrag speichert das Portal zusätzlich selbst.',
    platzhalter: [...auftrag, PH.datei, PH.heute, PH.benutzer, PH_DOKID],
    standard: { titel: 'Auftrag {auftragsnr} – {datei|ohneEndung}', korrespondent: '{kunde}', tags: 'Auftrag {auftragsnr}', datum: '{heute}' },
  },
  kontaktDokument: {
    id: 'kontakt.dokument', text: 'Dokument zum Kontakt',
    platzhalter: [{ name: 'kontakt', text: 'Kontakt (Korrespondent)', beispiel: 'Holz Müller GmbH' }, { name: 'adrnr', text: 'Kontaktnummer', beispiel: '792' }, PH.datei, PH.heute, PH.benutzer, PH_DOKID],
    standard: { titel: '{kontakt} – {datei|ohneEndung}', korrespondent: '{kontakt}', datum: '{heute}', notiz: 'Abgelegt beim Kontakt {adrnr} ({benutzer}, Euroflex-Portal)' },
  },
  rechnung: {
    id: 'rechnung', text: 'Ausgangsrechnung (ZUGFeRD-PDF)',
    beschreibung: 'Rechnungen, die über „Versenden → Paperless“ abgelegt werden.',
    platzhalter: [{ name: 'faktura', text: 'Rechnungsnummer', beispiel: '2026_5001' }, { name: 'kunde', text: 'Rechnungsempfänger (Korrespondent)', beispiel: 'Holz Müller GmbH' },
      { name: 'datum', text: 'Rechnungsdatum', beispiel: '2026-11-08' }, { name: 'betrag', text: 'Rechnungsbetrag brutto', beispiel: 1344.9 }, { name: 'titel', text: 'Titel laut Rechnung', beispiel: 'Sammelrechnung 2026_5001 - Holz Müller GmbH' },
      { name: 'auftraege', text: 'Auftragsnummern (kommagetrennt)', beispiel: '2026_0150, 2026_0153' }, PH.datei, PH.heute, PH.benutzer, PH_DOKID],
    standard: { titel: '{titel}', korrespondent: '{kunde}', datum: '{datum}', tags: '' },
  },
} satisfies Record<string, KontextDef>;

export const TRANSPORT_KONTEXTE: KontextDef[] = Object.values(K);
