# n8n-Workflow „TCO EP3 Import Portal“

Liefert dem Portal die EP3-Daten (Buchungen, Kunden **mit Kennwort-Hash**, Buchungstexte) als CSV in einer JSON-Antwort –
das Format, das `Hallenabrechnung → EP3-Import (n8n)` erwartet:

```json
{ "bookings_csv": "BID;DATUM;…", "kunden_csv": "ZUID;ZALIAS;STATUS;EMAIL;PW;KEY;VALUE…", "texte_csv": "BID;TEXT…" }
```

## Einrichten

1. In n8n: **Workflows → Import from File** → `tco-ep3-import.json`.
2. Zugangsdaten setzen:
   - Node *EP3 Buchungen / EP3 Kunden / EP3 Texte*: MySQL-Zugang zur ep3-bs-Datenbank (nur Lesen genügt).
   - Node *Webhook*: Header-Auth (`Authorization`-Header mit frei gewähltem Geheimnis).
3. Workflow aktivieren. Die Produktions-URL des Webhooks (`…/webhook/tco-ep3-import`) und das Geheimnis im Portal unter
   **Stammdaten → Anbindungen → EP3-Import** eintragen (Feld „Authorization“ = derselbe Header-Wert).
4. Im Portal **Hallenabrechnung → EP3-Import** ausführen. Die Meldung „Kunden: … Kennwörter übernommen“ zeigt, dass die Spalte PW ankommt.

## Bestehenden Workflow anpassen statt neu importieren

Wer den vorhandenen Workflow „TCO EP3 Import Hallenrechnungen“ behalten möchte, ergänzt nur in der Kundenabfrage die Spalte

```sql
u.pw AS PW
```

(aus `bs_users`). Alles Weitere erkennt das Portal automatisch; erneute Importe behalten Portalzuordnung und Kennwort.

## Hinweise

- Die Kennwort-Hashes sind bcrypt (`$2y$…`, Zend\Crypt in ep3-bs). Das Portal prüft sie bei der Registrierung mit EP3-Konto
  und beim Anmelden und stellt sie nach der ersten erfolgreichen Anmeldung auf das Portalverfahren (argon2) um.
- Die Buchungsabfrage liefert Termine der letzten 18 Monate; der Zeitraum lässt sich in `EP3 Buchungen` anpassen.
- Spaltennamen sind so gewählt, wie der Portalimport sie erwartet (`BID, DATUM, TIME_START, TIME_ENDE, KUNDE, STATUS, PLATZ`,
  `ZUID, ZALIAS, STATUS, EMAIL, PW, KEY, VALUE`, `BID, TEXT`). Datum `JJJJ-MM-TT`, Uhrzeit `HH:MM`.
