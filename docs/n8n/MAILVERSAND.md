# n8n-Workflow „TCO Mailversand“ (generisch)

Ein Webhook für **alle** E-Mails aus dem Portal: Hallenrechnungen, Mitglieder, Verzehr, Registrierung, Mitgliedsanträge,
Kennwort-Links. Jeder Aufrufer bestimmt Empfänger, Inhalt, Anhänge und den Absender aus den freigegebenen Konten.
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

## Absender und SMTP-Konten

Im Knoten **„Mail aufbereiten“** oben:

```js
const STANDARD = { email: 'torsten.laub@tc-oberthal.de', name: 'Tennisclub Oberthal e.V.' };
const KONTEN = {
  'torsten.laub@tc-oberthal.de': 'primaer',        // → Knoten „E-Mail senden (SMTP)“
  'benjamin.hartyniuk@tc-oberthal.de': 'zweit',    // → Knoten „E-Mail senden (SMTP Benjamin)“
};
```

- Ohne `absender` geht die Mail über `STANDARD`, also das primäre Konto.
- Der Knoten **„SMTP-Konto“** leitet nach `konto` auf den passenden SMTP-Knoten. Jeder Knoten hat eigene Zugangsdaten.
  Beim Import im Knoten „E-Mail senden (SMTP Benjamin)“ die Zugangsdaten **„TCO SMTP Benjamin“** anlegen: SMTP-Server, Benutzer
  `benjamin.hartyniuk@tc-oberthal.de`, Passwort.
- Ein Absender, der nicht in `KONTEN` steht, wird abgewiesen (HTTP 400). Für einen weiteren Absender trägt man ihn in `KONTEN` ein und
  legt bei Bedarf einen weiteren SMTP-Knoten samt Regel im Knoten „SMTP-Konto“ an.
- Entwürfe (`modus: "entwurf"`) landen immer im IMAP-Postfach des primären Kontos (INBOX.Drafts).
- Groß-/Kleinschreibung der Adresse spielt keine Rolle.

Im Portal: **Stammdaten → Anbindungen → TCO Mailversand → Absender je Anwendung**.
- Eine Zeile mit `*` legt den Standard fest.
- Weitere Zeilen gelten je Anwendung, z. B. `Hallenrechnung → benjamin.hartyniuk@tc-oberthal.de`.
- Groß-/Kleinschreibung der Anwendung spielt keine Rolle.
- Ohne Einträge sendet alles wie bisher mit dem `STANDARD` des Workflows.

## Einrichten / Aktualisieren

1. In n8n den bestehenden Workflow öffnen → Menü → **Import from File** → `tco-mailversand.json`. Alternativ nur den Code des
   Knotens „Mail aufbereiten“ ersetzen.
2. Zugangsdaten prüfen: *Header Auth account* (Webhook), *TCO SMTP account*, *TCO SMTP Benjamin*, *IMAP Credentials account*.
3. Zugangsdaten „TCO SMTP Benjamin“ anlegen, `STANDARD`/`KONTEN` prüfen, speichern, aktivieren.
4. Im Portal unter Stammdaten → Anbindungen „Testen“ (prüft nur, ob der Workflow aktiv ist) und die Absender pflegen.

Anwendungen im Portal: `Benutzer` (Kennwort-Links), `Registrierung`, `Mitgliedsantrag`, `Mitglieder`, `Hallenrechnung`, `Verzehr`.
