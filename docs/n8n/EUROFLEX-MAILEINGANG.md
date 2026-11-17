# n8n-Workflow „Euroflex Maileingang“ (Outlook 365)

Holt E-Mails samt Anhängen aus dem **gemeinsamen Eingangspostfach** in Outlook 365 und liefert sie an die App *Posteingang* der
Euroflex-Auftragsverwaltung – **nur für Euroflex**. Der Verein liest seine Postfächer weiter über
[„TCO Maileingang“](DOKUMENTENEINGANG.md). Datei: [`euroflex-maileingang.json`](euroflex-maileingang.json).
Fachliche Beschreibung (Zuordnung, Prüfliste, Ablage): [../euroflex-mailworkflows.md](../euroflex-mailworkflows.md).

- **Ein Postfach:** Es gibt praktisch nur ein Eingangspostfach; dessen Adresse steht im Knoten *Konfiguration*.
- **Nur ungelesene Mails** aus dem Quellordner (Standard: Posteingang), höchstens 50 je Lauf – der Rest folgt im nächsten Lauf.
- **Das Portal entscheidet**, was mit der Mail geschieht: Es antwortet mit einem Outlook-Ordner (Standard `Portal/Zugeordnet` bzw.
  `Portal/Prüfen`, einstellbar unter *Einstellungen → Euroflex → Mail-Workflows*). n8n legt fehlende Ordner unterhalb des
  Posteingangs an, verschiebt die Mail dorthin und markiert sie als gelesen.
- **Keine Antwort, keine Änderung:** Lehnt das Portal ab oder ist es nicht erreichbar, bleibt die Mail ungelesen liegen und kommt im
  nächsten Lauf erneut. Doppelt verarbeitet wird nichts – das Portal erkennt bekannte Mails (Postfach + Message-ID) und antwortet
  mit `doppelt` samt Ordner.
- **Die Anmeldung an Microsoft 365 liegt nur in n8n** (dieselbe App wie beim [Mailversand](EUROFLEX-MAILVERSAND.md)). Das Portal
  kennt nur den Webhook für „Posteingang abrufen“.

> **Stand:** Der Workflow ist nach den Dokumentationen von n8n und Microsoft Graph gebaut und in der CI auf Aufbau und Logik der
> Code-Knoten geprüft (`server/test/n8n_euroflex_maileingang.test.ts`, mit nachgestellten Antworten von Graph und Portal).
> Gegen ein echtes n8n und ein echtes Postfach ist er **nicht** gelaufen – der erste echte Lauf ist der Probelauf in Abschnitt 6.
> Ungeprüft sind insbesondere: die Ordnerschleife (*Ordner planen* ↔ *Ordner suchen/anlegen*) in n8n selbst und ob Graph
> `internetMessageHeaders` in der Liste für jede Mail liefert (sonst fehlen `in_reply_to`/`references`, die Zuordnung über
> Auftragsnummer und Absender greift weiter).

## Ablauf

```
Manuell starten ─┐
Alle 5 Minuten ──┼─> Konfiguration ─> Mails lesen (Graph, ungelesen, $top=50) ─> Mails aufteilen ─> Anhänge laden (Graph, je Mail)
Webhook Portal ──┘   (POSTFACH,        GET /users/{p}/mailFolders/{ordner}/messages            GET /users/{p}/messages/{id}/attachments
                      QUELLORDNER, MAX)
  ─> Für Portal packen ─> Lieferbar? ─> An Portal liefern ─> Antwort auswerten ─> Ordner planen ─> Ordner fehlt?
                                        POST /api/m/transport/                         ▲               │ ja        │ nein
                                        eingang/mail (API-Schlüssel)                   │               ▼           ▼
                                                                                       │      Ordner suchen   Verschieben aufteilen
                                                                                       │      Suche auswerten ─> Verschieben (Graph move)
                                                                                       │      Anlegen? ──nein──┐   Verschiebung auswerten
                                                                                       │        │ ja           │   Verschoben?
                                                                                       │      Ordner anlegen   │   Als gelesen markieren (Graph PATCH)
                                                                                       └───── Anlage auswerten ┘   Ergebnis
```

## 1 Outlook-365-Berechtigung (Microsoft Entra)

Der Workflow nutzt **dieselbe App-Registrierung** wie der Mailversand (Anmeldung als App per OAuth 2.0 „Client Credentials“,
siehe [EUROFLEX-MAILVERSAND.md, Abschnitt 1](EUROFLEX-MAILVERSAND.md#1-outlook-365-berechtigung-microsoft-entra)). Für jedes
Eingangspostfach (z. B. info@ und buchhaltung@) braucht die App **Mail.ReadWrite** als Anwendungsberechtigung: lesen, Anhänge laden, Ordner anlegen, verschieben,
als gelesen markieren. **Mail.Send ist für den Eingang nicht nötig.**

- **Weg A (auf Postfächer begrenzt, empfohlen):** Das Eingangspostfach als **direktes Mitglied** in die Gruppe aufnehmen, die beim
  Mailversand den Bereich festlegt (z. B. „Euroflex Versandpostfächer“). Die Rollenzuweisung „Application Mail.ReadWrite“ für
  diesen Bereich besteht dann schon. Kontrolle in der Exchange-Online-PowerShell:

  ```powershell
  Test-ServicePrincipalAuthorization -Identity "n8n Euroflex Mailversand" -Resource <eingangspostfach@firma>
  ```

  Für „Application Mail.ReadWrite“ muss `InScope: True` stehen. Änderungen wirken nach 30 Minuten bis 2 Stunden.
  Soll das Eingangspostfach nicht senden dürfen, stattdessen eine eigene Gruppe mit eigenem Bereich anlegen und nur
  `New-ManagementRoleAssignment -App <Anwendungs-ID> -Role "Application Mail.ReadWrite" -CustomResourceScope "<Bereich>"` vergeben.
- **Weg B (ohne Begrenzung):** `Mail.ReadWrite` ist bereits als Anwendungsberechtigung erteilt – nichts zu tun.

## 2 Zugangsdaten in n8n

Alle Zugangsdaten stehen nur in n8n; die Workflow-Datei im Repository enthält keine.

**Microsoft Graph** – die vorhandene Zugangsdatei `Euroflex Microsoft Graph` (Typ „OAuth2 API“, Grant Type Client Credentials) aus
dem Mailversand wiederverwenden. Nichts Neues anlegen.

**API-Schlüssel des Portals** – zuerst im Portal unter *Administration → Schnittstellen → API-Schlüssel* (Recht
`core.apikeys:edit`) einen Schlüssel anlegen:

| Feld | Wert |
|---|---|
| Modul | Euroflex (`transport`) |
| Name | z. B. `n8n Maileingang` |
| Berechtigungen | **`transport.eingang:execute`** (nichts weiter) |
| Gültig bis | optional; Ablaufdatum vormerken |

Vergeben lassen sich nur Rechte, die der Anlegende selbst besitzt. Der Schlüssel (`pk_transport_…`) wird **nur einmal** angezeigt. Dann in n8n *Credentials → Create credential → „Header Auth“*:
Name der Zugangsdatei `Euroflex Portal API-Schlüssel`, Feld **Name** = `Authorization`, Feld **Value** = `Bearer ` gefolgt vom Schlüssel.

**Webhook „Posteingang abrufen“** – *Credentials → Create credential → „Header Auth“*: Name der Zugangsdatei
`Euroflex Maileingang Webhook`, Feld **Name** = `X-Euroflex-Key`, Feld **Value** = ein selbst gewähltes langes
Geheimnis (z. B. `openssl rand -hex 32`) – **nicht** der API-Schlüssel des Portals.

## 3 Workflow importieren und eintragen

1. *Workflows → Import from File* → `euroflex-maileingang.json`.
2. Knoten **Konfiguration**: `POSTFAECHER` = Adressen der Eingangspostfächer, z. B. `['info@euro-flex.de', 'buchhaltung@euro-flex.de']`
   (eine ältere Konfiguration mit `POSTFACH` gilt weiter). Jede Adresse ist Teil des Schlüssels im Portal (Postfach +
   Message-ID) – **später nicht mehr ändern**. Jedes Postfach wird bei jedem Lauf gelesen; die App braucht für jedes Mail.ReadWrite
   (Abschnitt 1). Bezeichnungen für den Posteingang: im Portal unter *Einstellungen → Mail-Workflows → Eingang → Eingangspostfächer*. Bei Bedarf `QUELLORDNER` (Standard `Inbox`; bekannter Ordnername oder Ordner-ID aus
   Graph), `ZIELWURZEL` (unter diesem Ordner liegen die Zielordner, Standard `Inbox`) und `MAX` (Mails je Lauf, Standard 50).
3. Knoten **Mails lesen**, **Anhänge laden**, **Ordner suchen**, **Ordner anlegen**, **Verschieben**, **Als gelesen markieren**:
   unter *OAuth2 API* jeweils „Euroflex Microsoft Graph“ wählen.
4. Knoten **An Portal liefern**: unter *Header Auth* „Euroflex Portal API-Schlüssel“ wählen. `http://app:8080` gilt nur, wenn n8n im
   selben Docker-Stack läuft – sonst die Adresse des Portals aus Sicht von n8n eintragen.
5. Knoten **Webhook Portal**: unter *Credential for Header Auth* „Euroflex Maileingang Webhook“ wählen.
6. Speichern. **Noch nicht aktivieren** – erst den Probelauf (Abschnitt 6).

Nach jedem erneuten Import sind die Schritte 2 bis 5 zu wiederholen.

## 4 Im Portal eintragen

*Administration → Schnittstellen → Anbindungen → Euroflex Maileingang* (Anbindung `transport.maileingang`, Recht `core.settings:edit`):

| Feld | Wert |
|---|---|
| Webhook-URL | `http://n8n:5678/webhook/euroflex-maileingang` (Production-URL, nicht `/webhook-test/`) |
| Anmeldung | Schlüssel im eigenen Header, Header-Name `X-Euroflex-Key` (vorbelegt) |
| Wert / Geheimnis | derselbe Wert wie in der n8n-Zugangsdatei „Euroflex Maileingang Webhook“ |

Die Anbindung ist nur für den Knopf **„Posteingang abrufen“** in der App *Posteingang* nötig; ohne sie läuft der Eingang trotzdem
alle 5 Minuten. Ein Aufruf startet einen echten Abruf (keine reine Verbindungsprüfung).

## 5 Funktionsschalter und Rechte

*Administration → Funktionen*, Bereich Euroflex:

| Funktion | Recht | Wirkung, wenn aus |
|---|---|---|
| `transport.eingang` – Posteingang | `transport.eingang:display`, `transport.eingang:edit` | App *Posteingang* fehlt |
| `transport.eingang.n8n` – E-Mail-Eingang über n8n | `transport.eingang:execute` (nur API-Schlüssel) | das Portal weist jede Lieferung ab; die Mails bleiben ungelesen im Postfach, der Lauf endet in n8n mit „Keine Mail an das Portal geliefert“ |
| `transport.eingang.automatik` – Automatisch ablegen | – | jede Mail landet in der Prüfliste (Ordner `Portal/Prüfen`) |

Für den Betrieb müssen `transport.eingang` und `transport.eingang.n8n` eingeschaltet sein.

## 6 Probelauf

1. Eine Test-Mail mit PDF-Anhang und der Nummer eines bestehenden Auftrags (`JJJJ_NNNN`) im Betreff an das Eingangspostfach senden.
2. In n8n den Workflow öffnen und **Test workflow** (Knoten *Manuell starten*) ausführen.
3. Erwartung je Knoten: *Mails lesen* → HTTP 200 mit der Mail; *Für Portal packen* → `ok: true`, Anhang mit `inhalt`;
   *An Portal liefern* → HTTP 200 mit `vorgang`, `status`, `aktion.ordner`; *Ordner suchen/anlegen* → beim ersten Lauf werden
   `Portal` und `Portal/Zugeordnet` bzw. `Portal/Prüfen` angelegt; *Verschieben* → HTTP 201; *Als gelesen markieren* → HTTP 200.
4. In Outlook liegt die Mail gelesen im Ordner *Posteingang → Portal → …*; im Portal steht sie in der App *Posteingang*
   (bzw. am Auftrag, wenn automatisch abgelegt).
5. Zweiten Lauf starten: *Mails lesen* liefert die Mail nicht mehr.
6. Workflow **aktivieren**; danach im Portal einmal **„Posteingang abrufen“** – unter *Executions* erscheint ein Lauf.

## Schnittstelle (n8n → Portal)

| Aufruf | Zweck |
|---|---|
| `POST /api/m/transport/eingang/mail` mit `Authorization: Bearer pk_transport_…` | Mail liefern (Recht `transport.eingang:execute`, höchstens 80 MB und 40 Anhänge) |
| `POST …/webhook/euroflex-maileingang` (Portal → n8n, Header aus der Anbindung) | Abruf sofort starten; n8n antwortet sofort, der Lauf folgt |

```json
{
  "postfach": "auftraege@firma.de",
  "graph_id": "AAMk…",
  "message_id": "<abc@mail.example>",
  "in_reply_to": "<…>", "references": "<…> <…>",
  "von": "Einkauf <einkauf@kunde.de>", "an": "auftraege@firma.de", "betreff": "AW: Lieferschein 2026_0153",
  "datum": "2026-11-17T06:12:00Z",
  "text": "…", "html": "<p>…</p>",
  "anhaenge": [{ "name": "Scan.pdf", "mime": "application/pdf", "inhalt": "<base64>" }]
}
```

Antwort: `{ "vorgang": 12, "status": "abgelegt" | "pruefen" | "ignoriert" | "doppelt", "auftragsnr": "2026_0153" | null,
"aktion": { "ordner": "Portal/Zugeordnet" } }`.

So füllt *Für Portal packen* die Felder aus der Graph-Mail:

| Feld | Quelle |
|---|---|
| `postfach` | Postfach aus `POSTFAECHER`, aus dem die Mail kam (klein geschrieben) |
| `graph_id` | `id` der Mail (ändert sich beim Verschieben – nur zur Nachverfolgung) |
| `message_id` | `internetMessageId`; fehlt sie, `<graph_id@graph.microsoft.com>` |
| `in_reply_to`, `references` | Kopfzeilen `In-Reply-To` / `References` aus `internetMessageHeaders`, sonst leer |
| `von`, `an` | `from` bzw. `toRecipients` als `Name <adresse>` (mehrere durch Komma) |
| `datum` | `receivedDateTime` (UTC) |
| `text` | Textteil; bei HTML-Mails grob aus dem HTML gewonnen (Tags entfernt, Absätze als Zeilen) |
| `html` | nur bei HTML-Mails: der HTML-Text unverändert |
| `anhaenge` | nur Dateianhänge (`#microsoft.graph.fileAttachment`), `contentBytes` unverändert als `inhalt`; Inline-Bilder gehen mit, das Portal filtert Signaturbilder, `.ics`, `.vcf`, `.p7s` |

**Nicht geliefert** werden angehängte E-Mails (`itemAttachment`, z. B. weitergeleitete Outlook-Nachricht als Anlage) und
Cloud-Verweise (`referenceAttachment`). Solche Mails kommen ohne diese Anlage an; die Datei bei Bedarf in Outlook speichern.

## Aufbau

| Knoten | Aufgabe |
|---|---|
| Manuell starten · Alle 5 Minuten · Webhook Portal | drei Auslöser, alle mit demselben Ablauf; der Webhook antwortet sofort |
| Konfiguration | `POSTFAECHER` (oder `POSTFACH`), `QUELLORDNER`, `ZIELWURZEL`, `MAX`; je Postfach ein Element; ohne Postfach bricht der Lauf mit Hinweis ab |
| Mails lesen · Mails aufteilen | ungelesene Mails des Quellordners; lehnt Graph ab, endet der Lauf mit Klartext (Executions) |
| Anhänge laden | je Mail `GET …/messages/{id}/attachments` |
| Für Portal packen · Lieferbar? | Lieferung bauen; Mails, deren Anhänge nicht ladbar oder zu viele/zu groß sind, werden ausgefiltert und bleiben ungelesen |
| An Portal liefern | `POST /api/m/transport/eingang/mail`; Ablehnungen brechen nicht ab („Never Error“) |
| Antwort auswerten | genau **ein** Element mit allen Ergebnissen; verschoben wird nur bei `aktion.ordner`. Wurde keine einzige Mail angenommen, endet der Lauf als Fehler |
| Ordner planen · Ordner fehlt? · Ordner suchen · Suche auswerten · Anlegen? · Ordner anlegen · Anlage auswerten | Schleife: Zielpfad Ebene für Ebene unter `ZIELWURZEL` auflösen (`childFolders?$filter=displayName eq '…'`), Fehlendes anlegen; höchstens 30 Schritte je Lauf |
| Verschieben aufteilen · Verschieben | `POST …/messages/{id}/move` je Mail |
| Verschiebung auswerten · Verschoben? · Als gelesen markieren | `PATCH …/messages/{neue id}` mit `isRead: true` (Graph vergibt beim Verschieben eine neue ID) |
| Ergebnis | Zusammenfassung des Laufs: geliefert, verschoben, gelesen, Status je Art, Fehler |

- **Fehler je Mail isoliert:** Alle HTTP-Knoten laufen mit „Never Error“ und *On Error → Continue*; eine kaputte Mail hält die
  übrigen nicht auf. Eine automatische Wiederholung gibt es bewusst nicht – der nächste Lauf ist die Wiederholung.
- **Reihenfolge Verschieben → als gelesen:** Scheitert das Verschieben, bleibt die Mail ungelesen im Posteingang und wird im nächsten
  Lauf erneut geliefert (`doppelt`) und dann verschoben. Scheitert nur das Markieren, liegt sie ungelesen im Zielordner – das stört
  nicht, weil nur der Quellordner gelesen wird.
- Kann ein Zielordner nicht gefunden oder angelegt werden, bleiben die betroffenen Mails ungelesen liegen; die anderen werden verschoben.

## Fehlersuche

| Meldung (n8n, Executions) | Ursache |
|---|---|
| „Knoten „Konfiguration“: unter POSTFAECHER …“ | Adressen der Eingangspostfächer fehlen |
| „Mails lesen … fehlgeschlagen (HTTP 401)“ | Zugangsdatei „Euroflex Microsoft Graph“ falsch oder Clientschlüssel abgelaufen |
| „… (HTTP 403)“ | App hat kein Mail.ReadWrite für dieses Postfach: Postfach nicht in der Gruppe (Weg A) oder Zuweisung noch nicht wirksam (bis 2 Stunden) |
| „… (HTTP 404)“ | Postfach oder `QUELLORDNER` gibt es nicht |
| „write EPIPE“ bzw. „Ungültige Anfrage (CSRF-Schutz)“ / „API-Schlüssel bitte im Header „Authorization“ …“ | Der API-Schlüssel kommt nicht als `Authorization: Bearer pk_…` an: in der Zugangsdatei „Euroflex Portal API-Schlüssel“ muss **Name** `Authorization` und **Value** `Bearer ` + Schlüssel lauten, und im Knoten *An Portal liefern* muss *Authentication* „Generic Credential Type → Header Auth“ mit dieser Zugangsdatei gewählt sein. Das Portal lehnt dann vor dem Hochladen ab, n8n meldet deshalb nur „write EPIPE“ |
| „Keine Mail an das Portal geliefert … (HTTP 401)“ | API-Schlüssel falsch, gesperrt oder abgelaufen; in der Zugangsdatei fehlt `Bearer ` |
| „… (HTTP 403)“ | Schlüssel ohne `transport.eingang:execute` oder Funktion „E-Mail-Eingang über n8n“ aus |
| „… (HTTP 404)“ / Verbindungsfehler | Portal-Adresse in *An Portal liefern* falsch oder Modul `transport` nicht aktiv |
| Mail bleibt dauerhaft ungelesen im Posteingang | *Für Portal packen* meldet zu viele (> 40) oder zu große (> 80 MB) Anhänge, oder das Portal lehnt sie ab. Mail in Outlook selbst bearbeiten und verschieben |
| Mail erscheint nie im Portal | Sie wurde in Outlook gelesen, bevor n8n sie abgeholt hat (nur **ungelesene** Mails werden geholt) – in Outlook wieder als ungelesen markieren |
| „Posteingang abrufen“ meldet einen Fehler | Anbindung „Euroflex Maileingang“: URL (Production) oder Header-Wert passt nicht zur Zugangsdatei des Webhooks, oder Workflow nicht aktiv |

In n8n zeigt *Executions* jeden Lauf mit den Antworten von Graph und Portal. Die Läufe enthalten Text und Anhänge der Mails; wer das
nicht speichern möchte, stellt in den Workflow-Einstellungen *Save successful production executions* auf „Do not save“.
