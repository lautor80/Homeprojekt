import type { FunktionDef } from '../../../server/src/funktionsschalter.js';

/** Einzelne abschaltbare Funktionen von Euroflex (#232, F1) – reine Daten ohne weitere Importe */
export const TRANSPORT_FUNKTIONEN: FunktionDef[] = [
  {
    id: 'transport.rechnung.erstellen', app: 'Aufträge', text: 'Rechnungen erstellen',
    beschreibung: 'Aus Aufträgen Rechnungen erstellen.',
    permissions: ['transport.rechnungen:create'],
  },
  {
    id: 'transport.rechnung.entfernen', app: 'Aufträge', text: 'Rechnungen entfernen',
    beschreibung: 'Rechnungen wieder entfernen – die Aufträge sind danach wieder offen.',
    permissions: ['transport.rechnungen:delete'],
  },
  {
    id: 'transport.versand', app: 'Aufträge', text: 'Versand (E-Mail, Paperless)',
    beschreibung: 'Aufträge und Rechnungen per E-Mail versenden und in Paperless ablegen.',
    permissions: ['transport.versand:execute'],
  },
  {
    id: 'transport.versand.sammel', app: 'Aufträge', text: 'Versenden über Outlook 365',
    beschreibung: 'Knopf „Versenden…“ neben „Drucken“ in Auftragsliste und Auftragsdetail: ausgewählte Dokumente als E-Mails je Auftrag und Empfänger über n8n in die Outlook-Entwürfe legen.',
    routen: ['GET /versand/einstellungen', 'POST /versand/vorschau', 'POST /versand/ausfuehren', 'POST /versand/eml'],
  },
  {
    id: 'transport.versand.automatisch', app: 'Aufträge', text: 'Automatisch senden',
    beschreibung: 'Der Sammelversand sendet Dokumentarten, die in den Einstellungen auf „Senden“ stehen, direkt statt sie als Entwurf abzulegen.',
    permissions: ['transport.versandsenden:execute'],
    hinweis: 'Abgeschaltet landet jede E-Mail des Sammelversands als Entwurf in Outlook – auch wenn in den Einstellungen „Senden“ gewählt ist.',
  },
  {
    id: 'transport.eingang', app: 'Posteingang', text: 'Posteingang',
    beschreibung: 'App „Posteingang“: eingegangene E-Mails prüfen und am Auftrag ablegen.',
    permissions: ['transport.eingang:display', 'transport.eingang:edit'],
  },
  {
    id: 'transport.eingang.n8n', app: 'Posteingang', text: 'E-Mail-Eingang über n8n',
    beschreibung: 'n8n liefert E-Mails aus dem Outlook-365-Postfach samt Anhängen an das Portal (API-Schlüssel).',
    permissions: ['transport.eingang:execute'],
    hinweis: 'Die Lieferungen von n8n werden dann abgewiesen; die E-Mails bleiben im Postfach liegen.',
  },
  {
    id: 'transport.eingang.automatik', app: 'Posteingang', text: 'Automatisch ablegen',
    beschreibung: 'E-Mails, deren Zuordnung die Schwelle aus den Einstellungen erreicht, werden ohne Prüfung am Auftrag abgelegt.',
    hinweis: 'Abgeschaltet landet jede E-Mail in der Prüfliste.',
  },
  {
    id: 'transport.import', app: 'Produkte und Wertelisten', text: 'Datenimport aus SAP',
    beschreibung: 'Reiter „Datenimport“ in den Stammdaten: Kontakte, Produkte und Aufträge als CSV aus SAP einlesen.',
    permissions: ['transport.import:execute'],
  },
];
