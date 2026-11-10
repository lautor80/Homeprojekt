# n8n-Workflow „TCO Mailversand“ (generisch)

Ein Webhook für **alle** E-Mails aus dem Portal: Hallenrechnungen, Mitglieder, Verzehr, Registrierung, Mitgliedsanträge,
Kennwort-Links. Jeder Aufrufer bestimmt Empfänger, Inhalt und Anhänge. Absender ist, wer im Portal sendet – mit Rückfall auf die freigegebenen Konten.
Datei: [`tco-mailversand.json`](tco-mailversand.json). Sie basiert auf dem bisherigen Workflow „TCO Mailversand aus SAP“
mit denselben Knoten und Zugangsdaten und ist abwärtskompatibel.

## Aufruf

`POST …/webhook/tco-mailversand`, Header-Auth (im Portal: Administration → Anbindungen → E-Mail-Versand (n8n), „Webhook-Schlüssel“).

```json
{
  "modus": "senden",                    // oder "entwurf" (IMAP-Entwurf in INBOX.Drafts)
  "anwendung": "Mitgliedsantrag",       // Herkunft, erscheint im Header X-TCO-Objekt
  "objekt": "MA-2026-0001",
  "absender": "benjamin.hartyniuk@tc-oberthal.de", // wer sendet (Portal: angemeldeter Benutzer), optional
  "absender_name": "Benjamin Hartyniuk | TC Oberthal",
  "absender_ersatz": "torsten.laub@tc-oberthal.de",  // Ersatz je Anwendung, optional
  "absender_ersatz_name": "Tennisclub Oberthal e.V.",
  "antwort_an": "kassenwart@tc-oberthal.de", // optional (Reply-To)
  "an": "a@example.org, b@example.org",      // Text mit , oder ; – oder Liste ["a@…", "Name <b@…>"]
  "cc": "", "bcc": "",                       // wie "an", optional
  "betreff": "…",
  "text": "…", "text_format": "text",        // oder "html"
  "benutzer": "Portal", "quelle": "Portal",
  "anhaenge": [                               // beliebig viele, beliebige Typen
    { "dateiname": "Rechnung.pdf", "mime": "application/pdf", "inhalt_base64": "…",
      "paperless_root_id": 123, "paperless_version_id": 456, "objekt": "RG-2026-0042" }
  ]
}
```

Antwort: `{ "status": "gesendet" | "entwurf" | "fehler", "message_id", "zeitpunkt", "von", "hinweis", "empfaenger", "anhaenge", "fehler" }`.
Ungültige Aufrufe (kein Empfänger, ungültige Adresse, leerer Anhang) beantwortet der Workflow mit HTTP 400.

## Absender und SMTP-Konten

**Die Mail kommt von dem, der im Portal auf „Senden“ drückt.** Das Portal schickt die E-Mail-Adresse des angemeldeten Benutzers
als `absender` (Name: „Anzeigename | Verein“). Den Ersatz aus den Stammdaten schickt es als `absender_ersatz` mit.

Im Knoten **„Mail aufbereiten“** oben:

```js
const STANDARD = { email: 'torsten.laub@tc-oberthal.de', name: 'Tennisclub Oberthal e.V.' };
const KONTEN = {
  'torsten.laub@tc-oberthal.de': 'primaer',        // → Knoten „E-Mail senden (SMTP)“
  'benjamin.hartyniuk@tc-oberthal.de': 'zweit',    // → Knoten „E-Mail senden (SMTP Benjamin)“
};
```

Der Workflow nimmt die **erste** Adresse mit SMTP-Konto in `KONTEN`:

1. `absender`: wer auf „Senden“ gedrückt hat (bzw. ein fest gewählter Absender)
2. `absender_ersatz`: Ersatz je Anwendung aus den Portal-Stammdaten
3. `STANDARD`

Hat der gewünschte Absender kein SMTP-Konto (z. B. die private Adresse eines Vorstandsmitglieds), geht die Mail über den Ersatz bzw.
Standard. Antworten gehen dann per Reply-To trotzdem an ihn, sofern keine Antwortadresse vorgegeben ist und er nicht selbst Empfänger ist.
Die Antwort an das Portal meldet das in `von` und `hinweis`.

- Öffentliche Abläufe ohne Anmeldung (Registrierung, Mitgliedsantrag, Passwort vergessen) und Hintergrundläufe senden immer mit
  dem Ersatz bzw. Standard.
- Der Knoten **„SMTP-Konto“** leitet nach `konto` auf den passenden SMTP-Knoten. Beim Import im Knoten „E-Mail senden (SMTP Benjamin)“
  die Zugangsdaten **„TCO SMTP Benjamin“** anlegen (SMTP-Server, Benutzer `benjamin.hartyniuk@tc-oberthal.de`, Passwort).
- Einen weiteren eigenen Absender ergänzt man so: Eintrag in `KONTEN`, weiterer SMTP-Knoten und eine Regel im Knoten „SMTP-Konto“.
- Entwürfe (`modus: "entwurf"`) landen immer im IMAP-Postfach des primären Kontos (INBOX.Drafts).

Im Portal: **Administration → Anbindungen → E-Mail-Versand (n8n) → Ersatzabsender je Anwendung**.
- Eine Zeile mit `*` legt den Standard fest.
- Weitere Zeilen gelten je Anwendung, z. B. `Hallenrechnung → benjamin.hartyniuk@tc-oberthal.de`.
- Groß-/Kleinschreibung der Anwendung spielt keine Rolle.
- Ohne Einträge sendet alles wie bisher mit dem `STANDARD` des Workflows.

## Einrichten / Aktualisieren

1. In n8n den bestehenden Workflow öffnen → Menü → **Import from File** → `tco-mailversand.json`. Alternativ nur den Code des
   Knotens „Mail aufbereiten“ ersetzen.
2. Zugangsdaten prüfen: *Header Auth account* (Webhook), *TCO SMTP account*, *TCO SMTP Benjamin*, *IMAP Credentials account*.
   Im *Header Auth account* muss der **Name `X-TCO-Key`** lauten und der **Wert** dem „Webhook-Schlüssel“ im Portal entsprechen –
   sonst meldet das Portal „n8n hat den Webhook-Schlüssel abgelehnt“ (HTTP 401/403).
3. Zugangsdaten „TCO SMTP Benjamin“ anlegen, `STANDARD`/`KONTEN` prüfen, speichern, aktivieren.
4. Im Portal unter Administration → Anbindungen „Verbindung prüfen“ (prüft nur, ob der Workflow aktiv ist) und die Absender pflegen.

Anwendungen im Portal: `Benutzer` (Kennwort-Links), `Registrierung`, `Mitgliedsantrag`, `Mitglieder`, `Hallenrechnung`, `Verzehr`.

## Mailprotokoll und „Erneut senden“

Administration → Anbindungen → E-Mail-Versand (n8n) zeigt die letzten 50 Versuche (Zeit, Anwendung, Empfänger, Betreff, Absender, Status, Fehler)
und sendet eine Testmail über den kompletten Weg. Fehlgeschlagene Mails (`fehler`, `nicht_gesendet`) haben je Zeile **„Erneut senden“**:

- **Normale Mails** (Rechnungen, Verzehrbelege, Mitgliedermails, Benachrichtigungen): Der Inhalt samt Anhängen wird 30 Tage
  gespeichert und unverändert mit dem ursprünglichen Absender erneut übergeben. Danach wird nachgezogen, was der erste Versand getan hätte
  (Hallenrechnung „versendet“, Verzehrbeleg „per Mail versendet“). Der gespeicherte Inhalt wird nach Erfolg bzw. nach 30 Tagen gelöscht
  und nie an den Browser ausgeliefert.
- **Zugangslinks** (Bestätigung der Registrierung, Einladung/Schnellweg): Links werden nie gespeichert. „Erneut senden“ erzeugt einen
  **neuen Link**, ältere (auch auf gedruckten Briefen) werden ungültig.
- **Kennwort-Links und Startkennwörter** sind nicht wiederholbar; die Zeile nennt, wo sie neu ausgelöst werden.

Jede Wiederholung steht als eigener Eintrag im Protokoll; die ursprüngliche Zeile zeigt „Erneut gesendet am … von …“.

## App „E-Mail-Protokoll“

Administration → E-Mail-Protokoll (Berechtigung `core.mail:display`, nur lesend) zeigt dasselbe Protokoll als Tabelle mit Filter:
Suche (Name, Adresse, Vorgang, Betreff, Fehler), Anwendung, Status, Zeitraum (Vorgabe: letzte 30 Tage, höchstens 2000 Einträge je Suche)
und „Sammeln nach“ Person, Empfänger, Vorgang, Anwendung oder Status. Die Spalte **Person** nennt, wem die Empfängeradresse gehört:
Benutzer aus dem Kern, Mitglieder (auch Adresse des Zahlers), Hallenkunden und Registrierungen aus dem Modul (`ServerModule.mailPersonen`).
So findet die Suche nach einem Namen alle E-Mails an dessen Adresse, auch wenn noch kein Benutzer angelegt ist.
Ein Klick auf eine Zeile zeigt die Einzelheiten (Fehlertext, tatsächlicher Absender, Wiederholung); der Inhalt der E-Mail wird nie angezeigt.

Je Zeile gibt es **„Erneut senden“** (Berechtigung `core.mail:edit`, `POST /api/mail/uebersicht/:id/erneut`): dieselbe E-Mail geht noch einmal an
den Empfänger, auch wenn sie schon „gesendet“ war und beliebig oft; der **Absender der ersten E-Mail erhält eine Kopie (CC)**. Dafür wird der
Inhalt (samt Anhängen) jetzt bei **jeder** E-Mail 30 Tage gespeichert, nicht mehr nur im Fehlerfall – weiterhin nie Zugangslinks oder
Kennwörter: Bestätigungs- und Einladungslinks werden beim erneuten Senden neu erzeugt (ältere ungültig, der neue Link steht auch in der
Kopie), Kennwort-Links nennt die Zeile nur als „neu auslösen“. E-Mails von vor dem Update oder älter als 30 Tage sind nicht wiederholbar.
Nachgezogen (Rechnung „versendet“ …) wird nur, wenn der erste Versand fehlgeschlagen war.
„gesendet“ heißt: von n8n an den Mailserver übergeben – nicht, dass die E-Mail im Postfach angekommen ist (Spam-Ordner, Tippfehler in der Adresse).

## Rückmeldungen: unzustellbar, Abwesenheit, Antworten (Workflow „TCO Maileingang“)

„gesendet“ heißt nur: an den Mailserver übergeben. Ob die E-Mail ankam, zeigt erst die Rückmeldung im Postfach des Absenders.
Der Workflow „TCO Maileingang“ liest die Posteingänge und liefert jede neue Mail an das Portal. Seit dem Dokumenteneingang ist das
**ein einziger Aufruf** (`POST /api/m/tco/eingang/mail`), der beides erledigt: Rückmeldungen im E-Mail-Protokoll verbuchen und
Dokumente nach dem Regelwerk ablegen. Einrichtung und Aufbau: [DOKUMENTENEINGANG.md](DOKUMENTENEINGANG.md).

Das Portal ordnet zu und zeigt das Ergebnis im E-Mail-Protokoll an der gesendeten E-Mail:

| Art | Erkennung | Zuordnung |
|---|---|---|
| **unzustellbar** | Absender Mailer-Daemon/Postmaster oder Betreff wie „Mail delivery failed“, „Undelivered“ | Message-ID im Text, sonst jüngste gesendete E-Mail der letzten 7 Tage an eine im Text genannte Adresse |
| **Abwesenheitsnotiz** | Kopfzeile `Auto-Submitted: auto-replied` oder Betreff wie „Automatische Antwort“, „Out of office“ | jüngste gesendete E-Mail der letzten 2 Tage an den Absender |
| **Antwort** | alles andere | `In-Reply-To`/`References` = Message-ID der gesendeten E-Mail, sonst gleicher Betreff (ohne AW:/Re:) vom Empfänger innerhalb von 30 Tagen |

Im Protokoll wird aus „gesendet“ der Status **„unzustellbar“** (auch als Filter), die Spalte „Rückmeldung“ nennt den Grund des Mailservers
(z. B. `550 mailbox unavailable`) bzw. „Antwort von … (Zeit)“. Im E-Mail-Protokoll werden nur Art, Absender, Betreff, Zeit und bei
Rückläufern die Fehlerzeilen gespeichert – nie der Inhalt. Rückläufer und Abwesenheitsnotizen legt der Dokumenteneingang nicht ab;
Anhänge einer Antwort (z. B. ein unterschriebenes Formular) behandelt er wie jeden anderen Anhang.

Zum Test eine E-Mail an eine nicht existierende Adresse senden – spätestens fünf Minuten nach dem Rückläufer steht die Zeile auf
„unzustellbar“. „Gemeldet merken“ wirkt nur im aktiven Workflow, nicht bei „Execute workflow“ von Hand.

### Älterer Endpunkt

`POST /api/mail/eingang` (Webhook-Schlüssel der Anbindung „E-Mail-Versand“) nimmt weiterhin einzelne Rückmeldungen an, für
Installationen ohne Dokumenteneingang. Aufrufformat: `postfach`, `von`, `betreff`, `datum`, `message_id`, `in_reply_to`, `references`,
`auto` (Kopfzeile Auto-Submitted), `text` (wird nur ausgewertet). Antwort: `{ zugeordnet, art, protokoll, neu }`.
