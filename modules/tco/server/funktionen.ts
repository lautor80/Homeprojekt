import type { FunktionDef } from '../../../server/src/funktionsschalter.js';

/**
 * Einzelne abschaltbare Funktionen des Vereinsmoduls (#232, F1; Administration → Einstellungen → Funktionen).
 * Anwendung, Bereiche und Apps sind von selbst abschaltbar – hier steht nur, was INNERHALB einer App einzeln
 * abschaltbar sein soll. Reine Daten ohne weitere Importe (server/test/funktionen_verzeichnis.test.ts prüft Apps,
 * Rechte und Routen gegen den Quelltext).
 *
 * Eine Funktion wirkt über ihre Rechte (überall, wo das Recht geprüft wird) und über ihre Routen (werden abgewiesen).
 * Was weder eigenes Recht noch eigene Route hat, fragt im Handler funktionAktiv(id) und in der Oberfläche
 * useFunktion(id).
 */
export const F_EP3_IMPORT = 'tco.halle.ep3import';
export const F_BANKIMPORT = 'tco.fi.bankimport';
export const F_MANUELL = 'tco.fi.manuell';
export const F_JT_IMPORT = 'tco.jt.import';

export const TCO_FUNKTIONEN: FunktionDef[] = [
  // ---------------------------------------------------------------- öffentliche Formulare (ohne Anmeldung, also ohne Recht)
  {
    id: 'tco.antrag.formular', app: 'Mitgliedsanträge', text: 'Online-Mitgliedsantrag', seite: '/beitritt',
    beschreibung: 'Öffentliches Antragsformular /beitritt samt der Bestätigung eines Vertragsangebots. Abgeschaltet zeigt die Seite einen Hinweis.',
    routen: ['GET /antrag', 'POST /antrag', 'POST /antrag/angebot'],
    hinweis: 'Links und QR-Codes auf Website, Aushang und in bereits verschickten Vertragsangeboten führen dann auf den Hinweis. Eingegangene Anträge bleiben.',
  },
  {
    id: 'tco.mitglieder.einladung', app: 'Mitglieder', text: 'Einladung annehmen', seite: '/einladung', nurMitApp: true,
    beschreibung: 'Öffentliche Seite /einladung: Ein eingeladenes Mitglied wählt Benutzername und Kennwort.',
    routen: ['GET /einladung', 'POST /einladung'],
  },
  {
    id: 'tco.registrierung.formular', app: 'Registrierungen', text: 'Registrierung auf der Anmeldeseite', seite: '/registrierung-bestaetigen',
    beschreibung: 'Knopf „Registrieren“ auf der Anmeldeseite samt Bestätigungslink per E-Mail. Abgeschaltet verschwindet der Knopf.',
    routen: ['GET /platz/registrierung', 'GET /platz/registrierung/frei', 'POST /platz/registrierung/pruefen', 'POST /platz/registrierung',
      'POST /platz/registrierung/schnell', 'POST /platz/registrierung/bestaetigen'],
    hinweis: 'Über dasselbe Formular registrieren sich auch externe Hallennutzer. Noch nicht bestätigte Registrierungen lassen sich dann nicht mehr bestätigen; eingegangene bleiben.',
  },
  {
    id: 'tco.schnupper.formular', app: 'Schnuppertraining', text: 'Anmeldeformular Schnuppertraining', seite: '/schnuppertraining',
    beschreibung: 'Öffentliches Anmeldeformular /schnuppertraining. Abgeschaltet zeigt die Seite einen Hinweis.',
    routen: ['GET /schnupper', 'POST /schnupper'],
    hinweis: 'Links und QR-Codes auf Website und Aushang führen dann auf den Hinweis. Eingegangene Anmeldungen bleiben.',
  },
  {
    id: 'tco.schluessel.quittung', app: 'Hallenschlüssel', text: 'Online-Quittung', seite: '/schluessel-quittung', nurMitApp: true,
    beschreibung: 'Öffentliche Seite /schluessel-quittung: Empfang eines Hallenschlüssels über den zugesandten Link bestätigen.',
    routen: ['GET /schluessel/quittung', 'POST /schluessel/quittung'],
  },

  // ---------------------------------------------------------------- Funktionen innerhalb der Apps
  {
    id: 'tco.stammdaten.sap', app: 'Stammdaten', text: 'Übernahme aus SAP',
    beschreibung: 'Reiter „Übernahme aus SAP“ in den Stammdaten: SAP-Tabellen als CSV einlesen.',
    permissions: ['tco.import:execute'],
  },
  {
    id: F_EP3_IMPORT, app: 'Hallenabrechnung', text: 'EP3-Import',
    beschreibung: 'Hallenbuchungen aus EP3 holen (über n8n oder als CSV-Datei) und der Abgleich, ob im Portal Buchungen fehlen.',
    routen: ['GET /halle/import/abgleich', 'GET /halle/import/info', 'POST /halle/import/n8n', 'POST /halle/import/datei'],
    hinweis: 'Buchungen aus EP3 kommen dann nicht mehr in die Hallenabrechnung. Die Anbindung „EP3“ bleibt eingetragen.',
  },
  {
    id: F_JT_IMPORT, app: 'Abrechnung Jugendtraining', text: 'Import Trainerstunden',
    beschreibung: 'Reiter „Import“: Stundenrückmeldungen der Trainer aus der Nextcloud bzw. als Datei einlesen.',
    routen: ['POST /jt/import', 'POST /jt/import/nextcloud'],
  },
  {
    id: F_BANKIMPORT, app: 'FI-Belege', text: 'Bankimport',
    beschreibung: 'Umsätze aus der Bankdatei einlesen und als FI-Belege buchen.',
    routen: ['POST /fi/bank/lesen'],
    hinweis: 'Im Bankimport werden auch Zahlungseingänge zu Hallenrechnungen und die Gutschrift der Sollstellungen verbucht.',
  },
  {
    id: F_MANUELL, app: 'FI-Belege', text: 'Manuelle Buchung und Umbuchung',
    beschreibung: 'Buchungen ohne Bankdatei erfassen: Kasse, Konten ohne Bankdatei und Umbuchungen zwischen Geldkonten.',
  },
  {
    id: 'tco.fi.geldkonto', app: 'FI-Belege', text: 'Geldkonto tauschen',
    beschreibung: 'Bereits gebuchte Belege auf ein anderes Geldkonto umkontieren.',
    permissions: ['tco.fi:geldkonto'],
  },
  {
    id: 'tco.fi.storno', app: 'FI-Belege', text: 'Storno',
    beschreibung: 'FI-Belege stornieren.',
    permissions: ['tco.fi:storno'],
  },
  {
    id: 'tco.fi.periode', app: 'FI-Belege', text: 'Perioden abschließen',
    beschreibung: 'FI-Perioden (Monate) abschließen und wieder öffnen.',
    permissions: ['tco.fi:periode'],
  },
];
