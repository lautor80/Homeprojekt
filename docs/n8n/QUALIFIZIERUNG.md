# n8n-Workflow „TCO Paperless Qualifizierung“

Vorlage: [`tco-paperless-qualifizierung.json`](tco-paperless-qualifizierung.json). Der Workflow ergänzt jedes neue Dokument in
Paperless um Ausstellungsdatum, Betrag und – bei Getränkerechnungen – die Positionen (Custom Field „JSON“). Bei Dokumenten ohne
vorgegebenen Titel setzt er außerdem Titel und Korrespondent. Erledigte Dokumente erhalten ihre eigene ID im Custom Field „DOKID“.

```
Paperless: Dokument hinzugefügt (Webhook) ─┐
Alle 30 Minuten ───────────────────────────┼─> Konfiguration ─> Custom Fields / Korrespondenten / Dokumenttypen laden ─> Dokumente bestimmen
Manuell starten ───────────────────────────┘
   ─> Suchen? ─┬─ ja ──> Offene Dokumente suchen (DOKID leer) ─> IDs aus Liste ─┐
               └─ nein (ID aus dem Webhook) ────────────────────────────────────┴─> Je Dokument
   Je Dokument ─> Dokument laden ─> Vorprüfung ─> Weiter? ─> Datei laden ─> Anfrage bauen ─> OpenAI Analyse ─> Update bauen ─> Ändern? ─> Dokument aktualisieren ─┐
        ^────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

## Was der Workflow tut

| Schritt | Verhalten |
|---|---|
| Auslöser | **Sofort** über den Paperless-Workflow „Dokument hinzugefügt“ (Webhook). Alle 30 Minuten als Auffangnetz für Dokumente ohne DOKID (höchstens `LIMIT` je Lauf). |
| Vorprüfung | Dokumente mit gesetzter DOKID werden übersprungen (außer mit `"erneut": true` im Aufruf). Art: „Hallenrechnung“ und „Abrechnung Jugendtraining“ über den Dokumenttyp, Getränke über den Inhalt, sonst Standard. |
| Analyse | Die **Datei selbst** geht an das Modell: PDF als Datei, Bilder als Bild (`detail: high`). Die Texterkennung von Paperless dient nur als Hinweis, weil sie bei Scans und Fotos oft nicht reicht. Die Antwort ist per JSON-Schema festgelegt. |
| Übernahme | Nur **leere** Custom Fields werden gefüllt; was eine Regel im Portal gesetzt hat, bleibt. Titel nur, wenn er noch dem Dateinamen entspricht; Korrespondent nur, wenn keiner gesetzt ist und er in der Liste steht. Halle, Jugend und Getränke: Titel und Korrespondent nie. |
| Fehler | Schlägt die Analyse fehl, bleibt die DOKID leer – der nächste Lauf nach Zeitplan versucht es erneut. Kein Endlos-Kreislauf wie in der früheren Fassung. |

Nötige Custom Fields in Paperless: `DOKID`, `Betrag` (Geld), `Ausstellungsdatum` (Datum), `JSON` (Text). Fehlt eines außer DOKID,
wird es einfach nicht gefüllt.

## Einrichten

Es stehen **keine Schlüssel in den Knoten**. Alle Geheimnisse liegen in n8n-Zugangsdaten:

| Zugangsdaten (n8n) | Typ | Inhalt |
|---|---|---|
| Paperless API (Token) | Header Auth | Name `Authorization`, Wert `Token <API-Token aus Paperless → Profil>` |
| OpenAI | OpenAI | API-Schlüssel |
| Paperless-Workflow (Webhook) | Header Auth | Name `Authorization`, Wert `Bearer <frei gewählter geheimer Wert>` |

1. **Import from File** → `tco-paperless-qualifizierung.json`, in den Knoten die drei Zugangsdaten wählen.
2. **Konfiguration:** `PAPERLESS_URL` = Adresse von Paperless aus Sicht von n8n (im LAN), `MODELL`, `LIMIT`.
3. Workflow **aktivieren** und die Production-URL des Webhooks kopieren (`…/webhook/tco-paperless-qualifizieren`).
4. **Paperless → Workflows → Anlegen** (ab Paperless-ngx 2.14):
   - Auslöser: **Dokument hinzugefügt**
   - Aktion: **Webhook**, URL = Production-URL aus Schritt 3, „Als JSON senden“ an, „Parameter verwenden“ aus
   - Body: `{"doc_url": "{doc_url}", "titel": "{doc_title}"}`
   - Header: `{"Authorization": "Bearer <derselbe geheime Wert>"}`
   - Damit `{doc_url}` eine vollständige Adresse enthält, in Paperless `PAPERLESS_URL` setzen; der Workflow liest die ID aber auch aus einer relativen Adresse.
5. Den bisherigen Workflow (Schlüssel im Set-Knoten „Konfiguration“, Webhook „Paperless“ ohne Anmeldung) **deaktivieren und löschen**.
   Den OpenAI-Schlüssel und den Paperless-Token, die dort standen, **neu erzeugen** und nur noch in den Zugangsdaten hinterlegen.
6. Test: ein Dokument in Paperless hochladen – nach kurzer Zeit sind DOKID, Betrag und Datum gesetzt. Ein Dokument erneut qualifizieren:
   `POST …/webhook/tco-paperless-qualifizieren` mit `{"dokument_id": 123, "erneut": true}`.

## Zusammenspiel mit dem Dokumenteneingang

Das Portal legt Dokumente mit Titel, Korrespondent, Tags und – je Regel – Custom Fields ab und fasst bei Bedarf mehrere Anhänge zu
einem PDF zusammen. Paperless meldet das neue Dokument danach sofort an diesen Workflow; er ergänzt nur, was noch fehlt.
