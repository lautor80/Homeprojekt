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
    id: 'transport.liste.ladezeiten', app: 'Aufträge', text: 'Lade- und Entladezeiten in der Auftragsliste',
    beschreibung: 'Zweite Zeile der Spalte Route: Ladetermin des ersten Stops und Entladetermin der letzten Entladestelle (Datum und Uhrzeit bzw. Zeitfenster).',
    permissions: ['transport.ladezeiten:display'],
    hinweis: 'Abgeschaltet zeigt die Spalte Route nur die Orte.',
  },
  {
    id: 'transport.liste.abrechnung', app: 'Aufträge', text: 'Abrechnungsstatus in der Auftragsliste',
    beschreibung: 'Spalte „Abrechnung“ mit den Symbolen angelegt · abgerechnet · bezahlt (überfällig erst 3 Tage nach Fälligkeit) und Filter „Zahlung“.',
    permissions: ['transport.abrechnung:display'],
    hinweis: 'Schaltet auch „Zahlungseingang erfassen“ ab.',
  },
  {
    id: 'transport.zahlungen', app: 'Aufträge', text: 'Zahlungseingang erfassen',
    beschreibung: 'Menü „Zahlung“ in der Auftragsliste: Rechnungen als bezahlt markieren oder die Zahlung zurücknehmen.',
    permissions: ['transport.zahlungen:edit'],
  },
  {
    id: 'transport.tabellen', app: 'Aufträge', text: 'Tabellen anpassen (Spalten, Filter, Sortierung)',
    beschreibung: 'Knopf „Spalten“ an den Tabellen der Auftragsliste (Liste und Baum) und an Aufträgen und Dokumenten im Kontakt: Spalten ein-/ausblenden, Filter setzen, Sortierung – gespeichert mit der Ansichtsvariante.',
    permissions: ['transport.tabellen:edit'],
    hinweis: 'Abgeschaltet zeigen die Tabellen alle Spalten; gespeicherte Varianten behalten ihre Spaltenangaben, wenden sie aber nicht an.',
  },
  {
    id: 'transport.dialoge.schliessen', app: 'Aufträge', text: 'Versand- und Druckdialoge sofort schließen',
    beschreibung: 'Jeder Knopf, der versendet, einen E-Mail-Entwurf erzeugt oder Dokumente herunterlädt (Versenden …, E-Mail zum Auftrag, Versenden-Liste, PDF-Vorschau), schließt den Dialog sofort; das Ergebnis und Fehler kommen als Meldung unten im Bild.',
    permissions: ['transport.dialoge:execute'],
    hinweis: 'Abgeschaltet (oder ohne Recht) bleiben die Dialoge offen und zeigen Ergebnis und Fehler wie bisher (z. B. „Fehlgeschlagene erneut senden“).',
  },
  {
    id: 'transport.stops.vorschlaege', app: 'Aufträge', text: 'Vorschläge beim Erfassen der Stops',
    beschreibung: 'Beim Tippen in Firma, Straße, PLZ/Ort und Zeitvorgabe eines Stops schlägt das Portal Werte aus früheren Aufträgen vor; eine gewählte Firma übernimmt Straße, Land und PLZ/Ort mit.',
    permissions: ['transport.vorschlaege:display'],
    routen: ['GET /stops/vorschlaege'],
    hinweis: 'Abgeschaltet sind es wieder einfache Eingabefelder.',
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
    id: 'transport.versand.rechnung', app: 'Aufträge', text: 'Rechnungsversand: Absender-Postfach und BCC',
    beschreibung: 'E-Mails mit einer Rechnung gehen aus dem festen Absender-Postfach (z. B. Buchhaltung) und immer mit der festen BCC-Adresse '
      + '(z. B. DATEV-Upload) hinaus – im Dialog „E-Mail mit Anhängen…“ (Vorlage Rechnung), bei „Versenden…“ und in der E-Mail-Datei. '
      + 'Adressen: Administration → Einstellungen → Euroflex → Mail-Workflows.',
    hinweis: 'Abgeschaltet gehen Rechnungen wie alle anderen E-Mails aus dem Postfach des Benutzers und ohne BCC hinaus.',
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
