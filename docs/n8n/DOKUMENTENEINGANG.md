# n8n-Workflow „TCO Dokumenteneingang“

Liefert neue E-Mails samt Anhängen an das Portal und führt aus, was das Portal danach für die E-Mail vorsieht.
Das Regelwerk, die Ablage in Paperless/Nextcloud und die Prüfliste liegen im Portal – siehe [../dokumenteneingang.md](../dokumenteneingang.md).

Die Vorlage [`tco-dokumenteneingang.json`](tco-dokumenteneingang.json) wurde ohne laufendes n8n erstellt. **Nach dem Import jeden
Knoten einmal öffnen und mit „Execute step“ prüfen** – vor allem die IMAP-Knoten des zweiten Zweigs.

## Einrichten

1. Im Portal einen API-Schlüssel für das Modul „TC Oberthal“ mit der Berechtigung `tco.eingang:melden` anlegen.
2. In n8n **Import from File** → `tco-dokumenteneingang.json`.
3. Zugangsdaten vom Typ **Header Auth** anlegen: Name `Authorization`, Wert `Bearer pk_tco_…`; in den drei HTTP-Knoten auswählen.
   Die URL `http://app:8080` gilt, wenn n8n im selben Docker-Stack läuft – sonst die Adresse des Portals eintragen.
4. Knoten **Posteingang (IMAP)**: IMAP-Zugangsdaten des Postfachs wählen. In **Mail aufbereiten** `POSTFACH` (und bei Bedarf `ORDNER`) anpassen.
5. Zweiter Zweig: die Knoten **Als gelesen markieren**, **E-Mail verschieben** und **E-Mail in den Papierkorb** nutzen den
   Community-Knoten `n8n-nodes-imap` (wie der bisherige Workflow „TCO Maileingang“). Zugangsdaten wählen und Parameter prüfen;
   am einfachsten die funktionierenden Knoten aus dem bisherigen Workflow kopieren und UID sowie Ordner wie in der Vorlage verdrahten.
6. Workflow aktivieren. Der bisherige Sortier-Zweig bleibt abgeschaltet, sobald die Regeln im Portal aktiv sind.

**Weitere Postfächer:** „Posteingang (IMAP)“ und „Mail aufbereiten“ kopieren, Zugangsdaten und `POSTFACH` anpassen, mit
„An Portal liefern“ verbinden. Im zweiten Zweig je Postfach `…/mailaktionen?postfach=<Adresse>` abfragen und die passenden
IMAP-Zugangsdaten verwenden.

## Schnittstelle (alle mit `Authorization: Bearer <API-Schlüssel>`)

| Aufruf | Zweck |
|---|---|
| `POST /api/m/tco/eingang/mail` | E-Mail liefern. Antwort: `vorgang`, `neu`, `status`, `dokumente[]`, `mail` (Behandlung, sobald alles abgelegt ist, sonst `null`), `aufgaben[]`. |
| `GET /api/m/tco/eingang/mailaktionen[?postfach=…]` | Alle E-Mails, deren Behandlung aussteht: `vorgang`, `postfach`, `message_id`, `uid`, `quelle`, `art`, `ordner`, `gelesen`, `aufgaben`. |
| `POST /api/m/tco/eingang/vorgaenge/{vorgang}/mail-erledigt` | Behandlung ausgeführt. |
| `POST /api/m/tco/eingang/abgleich` | Für Abläufe, die das Postfach auflisten: `{ postfach, mails: [{ message_id, uid }] }` → `neu[]` (noch zu liefern) und `aktionen[]` (ausstehende Behandlung). |
| `GET /api/m/tco/eingang/vorgaenge/{vorgang}` | Stand eines Vorgangs. |

```json
{
  "postfach": "info@example.org", "ordner": "INBOX", "uid": 4711,
  "von": "SumUp <noreply@sumup.com>", "an": "info@example.org", "betreff": "Ihre Abrechnung",
  "datum": "Tue, 03 Nov 2026 10:00:00 +0100", "message_id": "<abc@sumup.com>",
  "text": "…", "html": "…",
  "anhaenge": [{ "name": "Abrechnung.pdf", "mime": "application/pdf", "inhalt": "<Base64>", "text": "optional: Dokumenttext" }]
}
```

`art` der Behandlung: `keine` (nur ggf. als gelesen markieren), `verschieben` (nach `ordner`), `loeschen` (in den Papierkorb).
Die Anfrage darf bis 80 MB groß sein, höchstens 40 Anhänge.

## Dokumenttext für Regeln

Soll eine Regel auf den Inhalt eines PDFs prüfen oder Felder daraus lesen, muss n8n den Text mitliefern: zwischen
„Posteingang (IMAP)“ und „Mail aufbereiten“ je PDF-Anhang den Knoten **Extract from File** (PDF) einsetzen und das Ergebnis in
„Mail aufbereiten“ in das Feld `text` des Anhangs schreiben. Ohne dieses Feld bleiben Bedingungen auf „Dokumenttext“ unerfüllt.

## Aufgaben

Regeln können eine Folgeaufgabe melden (`aufgaben: [{ titel, faellig_tage }]`). Der Knoten **Aufgabe anlegen (deaktiviert)** ist ein
Platzhalter: den bisherigen Knoten „Create a task“ dort einsetzen und aktivieren, wenn Aufgaben wieder angelegt werden sollen.
