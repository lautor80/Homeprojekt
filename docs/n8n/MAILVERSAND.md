# n8n-Workflow „TCO Mailversand“ (generisch)

Ein Webhook für **alle** E-Mails aus dem Portal: Hallenrechnungen, Mitglieder, Verzehr, Registrierung, Mitgliedsanträge,
Kennwort-Links. Jeder Aufrufer bestimmt Empfänger, Inhalt, Anhänge und – innerhalb einer Erlaubnisliste – den Absender.
Datei: [`tco-mailversand.json`](tco-mailversand.json). Sie basiert auf dem bisherigen Workflow „TCO Mailversand aus SAP“
mit denselben Knoten und Zugangsdaten und ist abwärtskompatibel.

## Aufruf

`POST …/webhook/tco-mailversand`, Header-Auth (im Portal: Stammdaten → Anbindungen → TCO Mailversand, „Webhook-Schlüssel“).

```json
{
  "modus": "senden",                    // oder "entwurf" (IMAP-Entwurf in INBOX.Drafts)
  "anwendung": "Mitgliedsantrag",       // Herkunft, erscheint im Header X-TCO-Objekt
  "objekt": "MA-2026-0001",
  "absender": "kassenwart@tc-oberthal.de",   // optional – sonst STANDARD im Workflow
  "absender_name": "Kassenwart TC Oberthal", // optional
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

Antwort: `{ "status": "gesendet" | "entwurf" | "fehler", "message_id", "zeitpunkt", "von", "empfaenger", "anhaenge", "fehler" }`.
Ungültige Aufrufe (kein Empfänger, ungültige Adresse, nicht erlaubter Absender, leerer Anhang) beantwortet der Workflow mit HTTP 400.

## Absender

Im Knoten **„Mail aufbereiten“** oben:

```js
const STANDARD = { email: 'torsten.laub@tc-oberthal.de', name: 'Tennisclub Oberthal e.V.' };
const ERLAUBT = ['@tc-oberthal.de'];   // ganze Domains oder einzelne Adressen
```

- Ohne `absender` gilt `STANDARD`.
- Ein `absender` außerhalb von `ERLAUBT` wird abgewiesen. Das schützt davor, dass jemand mit dem Webhook-Schlüssel beliebige Absender fälscht.
- **Das SMTP-Konto muss die Adressen versenden dürfen.** Je nach Anbieter heißt das „Alias“, „Weiterleitung mit Senden als“ oder „zusätzliche Absenderadresse“.
  Sonst lehnt der Server ab oder die Mail landet im Spam (SPF/DKIM der Domain beachten).

Im Portal: **Stammdaten → Anbindungen → TCO Mailversand → Absender je Anwendung**.
- Eine Zeile mit `*` legt den Standard fest.
- Weitere Zeilen gelten je Anwendung, z. B. `Registrierung → portal@…`, `Mitgliedsantrag → kassenwart@…`, `Hallenrechnung → halle@…`.
- Groß-/Kleinschreibung der Anwendung spielt keine Rolle.
- Ohne Einträge sendet alles wie bisher mit dem `STANDARD` des Workflows.

## Einrichten / Aktualisieren

1. In n8n den bestehenden Workflow öffnen → Menü → **Import from File** → `tco-mailversand.json`. Alternativ nur den Code des
   Knotens „Mail aufbereiten“ ersetzen.
2. Zugangsdaten prüfen: *Header Auth account* (Webhook), *TCO SMTP account*, *IMAP Credentials account*.
3. `STANDARD` und `ERLAUBT` anpassen, speichern, aktivieren.
4. Im Portal unter Stammdaten → Anbindungen „Testen“ (prüft nur, ob der Workflow aktiv ist) und die Absender pflegen.

Anwendungen im Portal: `Benutzer` (Kennwort-Links), `Registrierung`, `Mitgliedsantrag`, `Mitglieder`, `Hallenrechnung`, `Verzehr`.
