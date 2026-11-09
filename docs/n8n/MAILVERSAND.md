# n8n-Workflow „TCO Mailversand“ (generisch)

Ein Webhook für **alle** E-Mails aus dem Portal: Hallenrechnungen, Mitglieder, Verzehr, Registrierung, Mitgliedsanträge,
Kennwort-Links. Jeder Aufrufer bestimmt Empfänger, Inhalt und Anhänge. Absender ist, wer im Portal sendet – mit Rückfall auf die freigegebenen Konten.
Datei: [`tco-mailversand.json`](tco-mailversand.json). Sie basiert auf dem bisherigen Workflow „TCO Mailversand aus SAP“
mit denselben Knoten und Zugangsdaten und ist abwärtskompatibel.

## Aufruf

`POST …/webhook/tco-mailversand`, Header-Auth (im Portal: Stammdaten → Anbindungen → TCO Mailversand, „Webhook-Schlüssel“).

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

Im Portal: **Stammdaten → Anbindungen → TCO Mailversand → Absender je Anwendung**.
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
4. Im Portal unter Stammdaten → Anbindungen „Testen“ (prüft nur, ob der Workflow aktiv ist) und die Absender pflegen.

Anwendungen im Portal: `Benutzer` (Kennwort-Links), `Registrierung`, `Mitgliedsantrag`, `Mitglieder`, `Hallenrechnung`, `Verzehr`.

## Mailprotokoll und „Erneut senden“

Stammdaten → Anbindungen → TCO Mailversand zeigt die letzten 50 Versuche (Zeit, Anwendung, Empfänger, Betreff, Absender, Status, Fehler)
und sendet eine Testmail über den kompletten Weg. Fehlgeschlagene Mails (`fehler`, `nicht_gesendet`) haben je Zeile **„Erneut senden“**:

- **Normale Mails** (Rechnungen, Verzehrbelege, Mitgliedermails, Benachrichtigungen): Der Inhalt samt Anhängen wird nur im Fehlerfall
  gespeichert und unverändert mit dem ursprünglichen Absender erneut übergeben. Danach wird nachgezogen, was der erste Versand getan hätte
  (Hallenrechnung „versendet“, Verzehrbeleg „per Mail versendet“). Der gespeicherte Inhalt wird nach Erfolg bzw. nach 30 Tagen gelöscht
  und nie an den Browser ausgeliefert.
- **Zugangslinks** (Bestätigung der Registrierung, Einladung/Schnellweg): Links werden nie gespeichert. „Erneut senden“ erzeugt einen
  **neuen Link**, ältere (auch auf gedruckten Briefen) werden ungültig.
- **Kennwort-Links und Startkennwörter** sind nicht wiederholbar; die Zeile nennt, wo sie neu ausgelöst werden.

Jede Wiederholung steht als eigener Eintrag im Protokoll; die ursprüngliche Zeile zeigt „Erneut gesendet am … von …“.
