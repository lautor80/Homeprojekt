import { PH, PH_DOKID, type KontextDef } from '../../../server/src/lib/paperless-mapping.js';

/**
 * Ablagekontexte des Vereins für die zentrale Paperless-Zuordnung (Administration → Paperless-Zuordnung).
 * Die Standardregeln entsprechen dem bisherigen Verhalten der Apps.
 */
const mitglied = [
  { name: 'mitglied', text: 'Mitglied „Nachname Vorname“ (Korrespondent)', beispiel: 'Muster Max' },
  { name: 'vorname', text: 'Vorname', beispiel: 'Max' },
  { name: 'nachname', text: 'Nachname', beispiel: 'Muster' },
  { name: 'adrnr', text: 'Adressnummer', beispiel: '0000000123' },
  { name: 'mitglnr', text: 'Mitgliedsnummer', beispiel: '000123' },
];

export const K = {
  upload: {
    id: 'upload', text: 'Dokumenten-Upload / Ablagefeld',
    beschreibung: 'Dateien aus „Dokumenten-Upload“ und dem Ablagefeld der Navigation. Dokumenttyp, Korrespondent, Tags und Speicherpfad wählt der Benutzer; die Regel liefert Titel, Datum, Notiz und Custom Fields.',
    platzhalter: [PH.datei, { name: 'titel', text: 'vom Benutzer eingegebener Titel', beispiel: 'Rechnung Stadtwerke' }, { name: 'datum', text: 'vom Benutzer gewähltes Datum', beispiel: '2026-11-08' }, PH.heute, PH.benutzer, PH_DOKID],
    standard: { titel: '{titel}', datum: '{datum}', notiz: '' },
    benutzerwahl: ['dokumenttyp', 'korrespondent', 'speicherpfad', 'tags'],
  },
  fiBeleg: {
    id: 'fi.beleg', text: 'FI-Beleg (Ablage auf Buchung, Bankimport, Strg+V)',
    beschreibung: 'Belege, die in den FI-Belegen abgelegt werden. Belegnummer und SAP-Kennzeichen setzt die Zuordnung zur Buchung weiterhin selbst.',
    platzhalter: [PH.datei, { name: 'buchungen', text: 'interne Belegnummern (kommagetrennt), leer bei offenem Beleg', beispiel: '0000001234' },
      { name: 'fi_belegtyp', text: 'erster FI-Belegtyp aus den Stammdaten', beispiel: 'Eingangsrechnung' }, { name: 'fi_belegpfad', text: 'FI-Speicherpfad aus den Stammdaten', beispiel: 'Buchhaltung' },
      PH.heute, PH.benutzer, PH_DOKID],
    standard: { titel: '{datei|ohneEndung}', dokumenttyp: '{fi_belegtyp}', speicherpfad: '{fi_belegpfad}', datum: '{heute}', notiz: '' },
  },
  mitgliedDatei: {
    id: 'mitglied.datei', text: 'Mitglied – Datei ablegen',
    beschreibung: 'Dateien und Screenshots in der Mitgliederakte (Reiter Dokumente, Ablagefeld, Strg+V). Den Dokumenttyp wählt der Benutzer.',
    platzhalter: [...mitglied, PH.datei, { name: 'titel', text: 'eingegebener Titel', beispiel: 'Beitrittserklärung' }, { name: 'doktyp', text: 'gewählter Dokumenttyp', beispiel: 'Beitrittserklärung' },
      { name: 'notiz', text: 'eingegebene Notiz', beispiel: 'per Post erhalten' }, PH.heute, PH.benutzer, PH_DOKID],
    standard: { titel: '{titel}', korrespondent: '{mitglied}', dokumenttyp: '{doktyp}', speicherpfad: 'Mitglieder', datum: '{heute}', notiz: '{notiz}' },
    benutzerwahl: ['dokumenttyp', 'titel', 'notiz'],
  },
  mitgliedUnterlage: {
    id: 'mitglied.unterlage', text: 'Mitglied – erzeugte Unterlage (Beitrittserklärung, SEPA-Mandat …)',
    beschreibung: 'PDFs, die das Portal aus den Mitgliedsdaten erzeugt und ablegt.',
    platzhalter: [...mitglied, { name: 'art', text: 'Art der Unterlage', beispiel: 'Beitrittserklaerung' }, { name: 'doktyp', text: 'Dokumenttyp laut Art', beispiel: 'Beitrittserklärung' }, PH.heute, PH.benutzer, PH_DOKID],
    standard: { titel: '{art}_{nachname}_{vorname}', korrespondent: '{mitglied}', dokumenttyp: '{doktyp}', speicherpfad: 'Mitglieder', datum: '{heute}', notiz: '{art} erzeugt ({benutzer}, Vereinsportal)' },
  },
  mitgliedAntrag: {
    id: 'mitglied.antrag', text: 'Aufnahmeantrag (PDF aus n8n/Upload)',
    platzhalter: [PH.datei, PH.heute, PH.benutzer, PH_DOKID],
    standard: { titel: '{datei|ohneEndung}', dokumenttyp: 'Aufnahmeantrag', speicherpfad: 'Mitglieder', datum: '{heute}' },
  },
  halleRechnung: {
    id: 'halle.rechnung', text: 'Hallenrechnung',
    platzhalter: [{ name: 'rgnr', text: 'Rechnungsnummer', beispiel: '2026_015' }, { name: 'kunde', text: 'Kunde (Korrespondent)', beispiel: 'Meier Max' },
      { name: 'betrag', text: 'Rechnungsbetrag', beispiel: 160 }, { name: 'angelegt_am', text: 'Rechnungsdatum', beispiel: '2026-11-01' }, PH.heute, PH.benutzer, PH_DOKID],
    standard: { titel: 'Hallenrechnung {rgnr}', korrespondent: '{kunde}', dokumenttyp: 'Hallenrechnung', speicherpfad: 'Buchhaltung', datum: '{angelegt_am}', felder: { Betrag: '{betrag}', DOKID: '{rgnr}' } },
  },
  jtNachweis: {
    id: 'jt.nachweis', text: 'Zeitnachweis Jugendtraining',
    platzhalter: [{ name: 'belegnr', text: 'Belegnummer', beispiel: 'JT_2026_10_MUSTER' }, { name: 'trainer', text: 'Trainer „Nachname Vorname“', beispiel: 'Muster Max' },
      { name: 'monat', text: 'Monat (JJJJMM)', beispiel: '202610' }, { name: 'betrag', text: 'Betrag', beispiel: 240 }, { name: 'stunden', text: 'Stunden', beispiel: 12 }, PH.heute, PH.benutzer, PH_DOKID],
    standard: { titel: '{belegnr}', korrespondent: '{trainer}', dokumenttyp: 'Abrechnung Jugendtraining', speicherpfad: 'Buchhaltung', datum: '{heute}', felder: { Betrag: '{betrag}', DOKID: '{dokid}' } },
  },
  sollLauf: {
    id: 'soll.lauf', text: 'Sollstellung (Lastschriftlauf)',
    platzhalter: [{ name: 'titel', text: 'Titel laut Lauf', beispiel: '2026_01_TCO_SOLLSTELLUNG_LAUF12' }, { name: 'laufid', text: 'Laufnummer', beispiel: '12' },
      { name: 'periode', text: 'Sollperiode (JJJJMM)', beispiel: '202601' }, { name: 'summe', text: 'Summe', beispiel: 12345.67 }, { name: 'anzahl', text: 'Anzahl Lastschriften', beispiel: 210 }, PH.verein, PH.heute, PH.benutzer, PH_DOKID],
    standard: { titel: '{titel}', korrespondent: '{verein}', dokumenttyp: 'Lastschrifteinzug', speicherpfad: 'Buchhaltung', datum: '{heute}', felder: { Betrag: '{summe}', DOKID: '{dokid}' } },
  },
  verzehr: {
    id: 'clubhaus.verzehr', text: 'Verzehrbeleg Clubhaus (Gastbeleg / Sammelabrechnung)',
    platzhalter: [{ name: 'rgnr', text: 'Belegnummer', beispiel: 'VZM-2026-11-0001' }, { name: 'person', text: 'Mitglied bzw. Gast „Nachname Vorname“ (Korrespondent)', beispiel: 'Muster Max' },
      { name: 'art', text: 'Gastbeleg / Sammelabrechnung', beispiel: 'Sammelabrechnung' }, { name: 'monat', text: 'Monat (JJJJMM, Sammelabrechnung)', beispiel: '202611' },
      { name: 'betrag', text: 'Betrag', beispiel: 38.5 }, { name: 'datum', text: 'Belegdatum', beispiel: '2026-11-30' }, PH.heute, PH.benutzer, PH_DOKID],
    standard: { titel: 'Verzehr {rgnr}', korrespondent: '{person}', dokumenttyp: 'Verzehrbeleg', speicherpfad: 'Buchhaltung', datum: '{datum}', felder: { Betrag: '{betrag}', DOKID: '{rgnr}' } },
  },
  clubhaus: {
    id: 'clubhaus.abrechnung', text: 'Clubhausabrechnung (Forderungsliste)',
    platzhalter: [{ name: 'titel', text: 'Titel laut Abrechnung', beispiel: 'Clubhausabrechnung 2026_10' }, { name: 'jahr', text: 'Jahr', beispiel: 2026 }, { name: 'monat', text: 'Monat', beispiel: 10 },
      { name: 'kontostand', text: 'offener Betrag', beispiel: 1234.5 }, { name: 'wirt', text: 'Pächter (Korrespondent)', beispiel: 'Wirt Willi' }, PH.heute, PH.benutzer, PH_DOKID],
    standard: { titel: '{titel}', korrespondent: '{wirt}', speicherpfad: 'Buchhaltung', datum: '{heute}', felder: { Betrag: '{kontostand}', DOKID: '{dokid}' } },
  },
  abschluss: {
    id: 'abschluss.jahr', text: 'Jahresabschluss',
    platzhalter: [{ name: 'titel', text: 'Titel laut Abschluss', beispiel: 'Jahresabschluss 2026' }, { name: 'jahr', text: 'Jahr', beispiel: 2026 }, { name: 'ergebnis', text: 'Ergebnis', beispiel: 4321 }, PH.verein, PH.heute, PH.benutzer, PH_DOKID],
    standard: { titel: '{titel}', korrespondent: '{verein}', speicherpfad: 'Buchhaltung', datum: '{jahr}-12-31', felder: { Betrag: '{ergebnis}', DOKID: '{dokid}' } },
  },
  ihMeldung: {
    id: 'instandhaltung.meldung', text: 'Schadensmeldung (Formular Instandhaltung)',
    beschreibung: 'Formular einer Schadensmeldung mit Protokoll und Fotos – abgelegt beim Abschluss oder bei der Weitergabe (z. B. an eine Fremdfirma); jede weitere Ablage wird eine neue Version desselben Dokuments.',
    platzhalter: [{ name: 'nummer', text: 'Meldungsnummer', beispiel: 'SM-2026-0007' }, { name: 'anlage', text: 'Wo (Ort/Anlage)', beispiel: 'Platz 3' },
      { name: 'gruppe', text: 'Gruppe des Orts', beispiel: 'Außenplätze' }, { name: 'kategorie', text: 'Kategorie', beispiel: 'Netz/Pfosten' },
      { name: 'auswirkung', text: 'Auswirkung', beispiel: 'Sicherheitsrisiko' }, { name: 'status', text: 'Status beim Ablegen', beispiel: 'Erledigt' },
      { name: 'anlass', text: 'Abschluss bzw. Weitergabe (mit Empfänger)', beispiel: 'Weitergabe an Sportplatzbau Muster GmbH' }, { name: 'empfaenger', text: 'Empfänger bei Weitergabe', beispiel: 'Sportplatzbau Muster GmbH' },
      { name: 'melder', text: 'gemeldet von', beispiel: 'Mia Matchball' }, { name: 'zustaendig', text: 'Zuständiger', beispiel: 'Paul Platzwart' },
      { name: 'kosten', text: 'Kosten (leer, wenn keine)', beispiel: 80 }, { name: 'eingang', text: 'Meldedatum', beispiel: '2026-11-12' },
      PH.verein, PH.heute, PH.benutzer, PH_DOKID],
    standard: {
      titel: 'Schadensmeldung {nummer} {anlage} – {kategorie}', korrespondent: '{verein}', dokumenttyp: 'Schadensmeldung', speicherpfad: 'Instandhaltung',
      tags: 'Instandhaltung', datum: '{heute}', notiz: '{anlass}: {status} ({benutzer}, Vereinsportal)', felder: { DOKID: '{dokid}' },
    },
  },
} satisfies Record<string, KontextDef>;

export const TCO_KONTEXTE: KontextDef[] = Object.values(K);
