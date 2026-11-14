# n8n-Workflow „TCO EP3 Import Portal“

Liefert dem Portal die EP3-Daten (Buchungen, Kunden **mit Kennwort-Hash**, Buchungstexte) als CSV in einer JSON-Antwort –
das Format, das `Hallenabrechnung → EP3-Import (n8n)` erwartet:

```json
{ "bookings_csv": "BID;DATUM;…", "kunden_csv": "ZUID;ZALIAS;STATUS;EMAIL;PW;KEY;VALUE…", "texte_csv": "BID;TEXT…", "events_csv": "EID;PLATZ;DATETIME_START;DATETIME_END;NAME;STATUS…" }
```

## Einrichten

1. In n8n: **Workflows → Import from File** → `tco-ep3-import.json`.
2. Zugangsdaten setzen:
   - Node *EP3 Buchungen / EP3 Kunden / EP3 Texte*: MySQL-Zugang zur ep3-bs-Datenbank (nur Lesen genügt).
   - Node *Webhook*: Header-Auth (`Authorization`-Header mit frei gewähltem Geheimnis).
3. Workflow aktivieren. Die Produktions-URL des Webhooks (`…/webhook/tco-ep3-import`) und das Geheimnis im Portal unter
   **Administration → Schnittstellen → Anbindungen → EP3-Export Hallenbuchungen (n8n)** eintragen (Anmeldung „Schlüssel im eigenen Header“,
   Header-Name `Authorization`, Wert = derselbe Header-Wert; bei Basic Auth stattdessen Benutzer und Passwort).
4. Im Portal **Hallenabrechnung → EP3-Import** ausführen. Die Meldung „Kunden: … Kennwörter übernommen“ zeigt, dass die Spalte PW ankommt.

## Bestehenden Workflow anpassen statt neu importieren

Wer den vorhandenen Workflow „TCO EP3 Import Hallenrechnungen“ behalten möchte, ergänzt nur in der Kundenabfrage die Spalte

```sql
u.pw AS PW
```

(aus `bs_users`). Alles Weitere erkennt das Portal automatisch; erneute Importe behalten Portalzuordnung und Kennwort.

## Events (Jugendtraining, Sperrzeiten)

EP3-Events (`bs_events`, Name aus `bs_events_meta.name`) werden als **feste Platzbelegungen** übernommen und ersetzen bei jedem Import die
zuvor aus EP3 übernommenen. Platz über Bezeichnung/Alias; Events ohne Platz gelten für alle Plätze. Eigene Belegungen pflegt die
Platzverwaltung unter „Training & Sperrzeiten“ – sie bleiben vom Import unberührt.

## Hinweise

- Die Kennwort-Hashes sind bcrypt (`$2y$…`, Zend\Crypt in ep3-bs). Das Portal prüft sie bei der Registrierung mit EP3-Konto
  und beim Anmelden und stellt sie nach der ersten erfolgreichen Anmeldung auf das Portalverfahren (argon2) um.
- Die Buchungsabfrage liefert standardmäßig Termine der letzten 18 Monate. Im Portal kann der Import einmalig **ab einem Datum**
  angefordert werden (*Hallenabrechnung → EP3 importieren → „Ab Datum nachladen“*): das Portal schickt `ab` (JJJJ-MM-TT) im Webhook,
  `EP3 Buchungen` verwendet es statt der 18 Monate, `CSV bauen` meldet `ab` zurück. Ältere Workflows ohne diese Anpassung liefern
  weiter ihren festen Zeitraum – das Portal zeigt das im Protokoll (Zeile „Zeitraum“: angefordert, tatsächlich geliefert).
- **Zeitraum verlängern – was passiert:** Buchungen, die es im Portal schon gibt (gleiche BID und gleiches Datum), bleiben erhalten;
  bereits abgerechnete werden nur um den Platz ergänzt. Fehlende Buchungen werden neu angelegt – ohne Rechnung. Liegen sie nach dem
  Stichtag „Buchungen abrechnen ab“ (Stammdaten), erscheinen sie in der Hallenabrechnung als offen. Wurden sie schon in SAP abgerechnet,
  zuerst Buchungen und Rechnungen aus SAP übernehmen (Stammdaten → Übernahme aus SAP, „Nur neue Sätze“) und erst dann nachladen.
  Kunden, Texte und Events haben keinen Zeitraum (Events: ab einem Monat zurück).
- Spaltennamen sind so gewählt, wie der Portalimport sie erwartet (`BID, DATUM, TIME_START, TIME_ENDE, KUNDE, STATUS, PLATZ`,
  `ZUID, ZALIAS, STATUS, EMAIL, PW, KEY, VALUE`, `BID, TEXT`). Datum `JJJJ-MM-TT`, Uhrzeit `HH:MM`.
