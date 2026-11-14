# n8n-Workflow „TCO Maileingang“ (Dokumenteneingang und Rückmeldungen)

Ein Workflow für alles, was in den Postfächern ankommt: [`tco-maileingang.json`](tco-maileingang.json). Er liefert jede neue Mail
samt Anhängen an das Portal und führt danach aus, was das Portal für die Mail vorsieht. Das Portal

- verbucht Unzustellbar-Meldungen, Abwesenheitsnotizen und Antworten im **E-Mail-Protokoll** (siehe [MAILVERSAND.md](MAILVERSAND.md)),
- legt Dokumente nach dem **Regelwerk** in Paperless und optional der Nextcloud ab (siehe [../dokumenteneingang.md](../dokumenteneingang.md)),
- meldet zurück, ob die Mail verschoben, als gelesen markiert oder in den Papierkorb gelegt werden soll.

```
Alle 5 Minuten ─────────────┐
Alle Mails jetzt ───────────┼─> Modus festlegen ─┬─> Posteingang lesen (IMAP) ─> Mail aufbereiten ─> Anhänge? ─┬─> Anhänge laden ─┐
Alle Mails jetzt (Webhook) ─┘                    │                                                             └──────────────────┴─> Für Portal packen ─> An Portal liefern ─> Gemeldet merken
                                                 └─> Ausstehende Mailaktionen ─> Mit Vorgang ─> Gelesen markieren? ─> (Als gelesen markieren) ─> Art der Behandlung
                                                                                    ─> E-Mail verschieben | E-Mail in den Papierkorb | – ─> Erledigt melden
```

**Zwei Betriebsarten** („Modus festlegen“):

| Start | Liest | Liefert |
|---|---|---|
| Alle 5 Minuten | E-Mails der letzten 2 Tage, höchstens 50 | nur neue (Merkliste „Gemeldet merken“, nicht älter als 3 Tage) |
| Alle Mails jetzt (Editor) oder Webhook (Portal: „Posteingang abrufen“) | alle E-Mails im Posteingang, höchstens 500 | alle erneut; das Portal bewertet nur E-Mails „ohne Regel“ neu |

Gelesene E-Mails sind in beiden Fällen dabei (kein Flag-Filter). Verschieben, Markieren und Löschen erledigt der untere Zweig; nach
einem Sofort-Start greift er für die gerade gelieferten E-Mails beim nächsten 5-Minuten-Lauf.

Alle IMAP-Knoten nutzen den Community-Knoten `n8n-nodes-imap` (wie „TCO Mailversand“), damit die UID der Mail für das spätere
Verschieben zur Verfügung steht.

## Einrichten

1. Im Portal unter **Administration → Schnittstellen → API-Schlüssel** einen Schlüssel für „TC Oberthal“ mit der Berechtigung `tco.eingang:melden` anlegen.
2. In n8n Zugangsdaten vom Typ **Header Auth** anlegen: Name `Authorization`, Wert `Bearer pk_tco_…`. In den drei HTTP-Knoten
   („An Portal liefern“, „Ausstehende Mailaktionen“, „Erledigt melden“) auswählen.
3. **Import from File** → `tco-maileingang.json` (oder den bestehenden Workflow „TCO Maileingang“ ersetzen). In den IMAP-Knoten die
   Zugangsdaten des Postfachs wählen.
4. URL des Portals: `http://app:8080` gilt nur, wenn n8n im selben Docker-Stack läuft – sonst in den drei HTTP-Knoten die Adresse des
   Portals aus Sicht von n8n eintragen.
5. In „Mail aufbereiten“ unter `POSTFAECHER` den Namen des Postfachs festlegen (z. B. „Verein“). Er ist Teil des Schlüssels im Portal
   und das Bedingungsfeld „Postfach“ der Regeln – **später nicht mehr ändern**, sonst gelten bekannte Mails als neu.
6. Im Knoten „E-Mail in den Papierkorb“ den Namen des Papierkorbs des Postfachs eintragen (z. B. `Trash`, `Papierkorb`).
7. **Sofort-Start aus dem Portal:** Im Knoten „Alle Mails jetzt (Webhook)“ Zugangsdaten „Portal-Abruf (Webhook)“ vom Typ **Header Auth**
   anlegen (Name `Authorization`, Wert `Bearer <geheimer Wert>` – eigener Wert, nicht der API-Schlüssel des Portals). Im Portal unter
   **Administration → Schnittstellen → Anbindungen → Maileingang jetzt abrufen (n8n)** die Production-URL des Webhooks
   (`…/webhook/tco-dokumenteneingang-alle`) eintragen, Anmeldung „Header“, Name `Authorization`, Wert wie in n8n.
8. Einmal von Hand ausführen und das Ergebnis im Portal unter Dokumenteneingang → Protokoll ansehen, dann aktivieren.

Der Endpunkt `POST /api/mail/eingang` (Rückmeldungen mit dem Webhook-Schlüssel) wird von diesem Workflow nicht mehr aufgerufen.

## Weitere Postfächer

„Posteingang lesen (IMAP Benjamin)“ ist vorbereitet und deaktiviert. Zum Einschalten: Zugangsdaten wählen, aktivieren, in
„Mail aufbereiten“ unter `POSTFAECHER` benennen. Weil n8n je Knoten nur eine Zugangsdatei kennt, brauchen „Anhänge laden“,
„Als gelesen markieren“, „E-Mail verschieben“ und „E-Mail in den Papierkorb“ je Postfach eine eigene Kopie, die nur dessen Mails
bekommt (vorgeschalteter Filter auf `postfach`); „Ausstehende Mailaktionen“ dann je Postfach mit `?postfach=<Name>` abfragen.

## Schnittstelle (alle mit `Authorization: Bearer <API-Schlüssel>`)

| Aufruf | Zweck |
|---|---|
| `POST /api/m/tco/eingang/mail` | Mail liefern. Antwort: `vorgang`, `neu`, `status`, `hinweis`, `dokumente[]`, `mail` (Behandlung, sobald alles abgelegt ist, sonst `null`), `aufgaben[]`, `rueckmeldung` (`art`, `zugeordnet`). |
| `GET /api/m/tco/eingang/mailaktionen[?postfach=…]` | Mails, deren Behandlung aussteht: `vorgang`, `postfach`, `message_id`, `uid`, `quelle`, `art`, `ordner`, `gelesen`, `aufgaben`. |
| `POST /api/m/tco/eingang/vorgaenge/{vorgang}/mail-erledigt` | Behandlung ausgeführt. |
| `POST /api/m/tco/eingang/abgleich` | `{ postfach, mails: [{ message_id, uid }] }` → `neu[]` (noch zu liefern) und `aktionen[]` (ausstehende Behandlung). |
| `GET /api/m/tco/eingang/vorgaenge/{vorgang}` | Stand eines Vorgangs. |

```json
{
  "postfach": "Verein", "ordner": "INBOX", "uid": 4711,
  "von": "SumUp <noreply@sumup.com>", "an": "info@example.org", "betreff": "Ihre Abrechnung",
  "datum": "Tue, 03 Nov 2026 10:00:00 +0100", "message_id": "<abc@sumup.com>",
  "in_reply_to": "", "references": "", "auto": "",
  "text": "…", "html": "…",
  "anhaenge": [{ "name": "Abrechnung.pdf", "mime": "application/pdf", "inhalt": "<Base64>", "text": "optional: Dokumenttext" }]
}
```

`art` der Behandlung: `keine` (nur ggf. als gelesen markieren), `verschieben` (nach `ordner`), `loeschen` (in den Papierkorb).
Die Anfrage darf bis 80 MB groß sein, höchstens 40 Anhänge.

## Dokumenttext für Regeln

Soll eine Regel auf den Inhalt eines PDFs prüfen oder Felder daraus lesen, muss n8n den Text mitliefern: nach „Anhänge laden“ je PDF
**Extract from File** einsetzen und in „Für Portal packen“ in das Feld `text` des Anhangs schreiben. Ohne dieses Feld bleiben
Bedingungen auf „Dokumenttext“ unerfüllt.

## Aufgaben

Regeln können eine Folgeaufgabe melden (`aufgaben: [{ titel, faellig_tage }]`). Der Knoten **Aufgabe anlegen (deaktiviert)** ist ein
Platzhalter: den bisherigen Knoten „Create a task“ dort einsetzen und aktivieren, wenn Aufgaben wieder angelegt werden sollen.
