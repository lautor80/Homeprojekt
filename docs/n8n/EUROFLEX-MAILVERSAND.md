# n8n-Workflow „Euroflex Mailversand“ (Outlook 365)

E-Mails zum Auftrag mit ausgewählten Dokumenten – **nur für Euroflex** (#235). Der Verein sendet weiter über
[„TCO Mailversand“](MAILVERSAND.md). Datei: [`euroflex-mailversand.json`](euroflex-mailversand.json).

- **Auswahl im Portal:** *Euroflex → Auftrag → Dokumente → „E-Mail mit Anhängen…“*. Anhänge aus dem Ablageordner des PCs und aus
  Paperless per Häkchen. Der Ablageordner ist nur im Browser lesbar, deshalb lädt der Browser die gewählten Dateien hoch.
- **Zwei E-Mails je Vorgang:** eine an den Empfänger (Kunde bzw. Unternehmer) und parallel eine **eigene E-Mail** mit gleichem
  Inhalt und gleichen Anhängen an die **feste zweite Adresse** aus der Anbindung.
- **Postfach je Benutzer:** gesendet wird über Microsoft Graph aus dem Outlook-365-Postfach dessen, der im Portal auf „Senden“
  drückt. Die E-Mail liegt danach in dessen *Gesendete Elemente*.
- **Die Anmeldung an Microsoft 365 liegt nur in n8n.** Das Portal kennt den Webhook und dessen Schlüssel.

> **Stand:** Der Workflow ist nach den Dokumentationen von n8n und Microsoft gebaut und in der CI auf Aufbau und Logik der
> Code-Knoten geprüft (`server/test/n8n_euroflex_mailversand.test.ts`). Gegen ein echtes n8n und ein echtes Postfach ist er
> **nicht** gelaufen – der erste echte Versand ist der Probeversand in Abschnitt 4.

## 1 Outlook-365-Berechtigung (Microsoft Entra)

n8n meldet sich **als App** an (OAuth 2.0 „Client Credentials“), nicht als Benutzer. So kann ein einziger Zugang aus dem Postfach
jedes zugelassenen Benutzers senden; niemand muss sich in n8n mit seinem Microsoft-Konto anmelden, und eine Redirect-URI
(HTTPS für n8n) wird nicht gebraucht. Nötig ist ein Administrator des Microsoft-365-Mandanten.

### 1.1 App registrieren

1. [Entra Admin Center](https://entra.microsoft.com) → *Anwendungen → App-Registrierungen → Neue Registrierung*.
2. Name: z. B. `n8n Euroflex Mailversand`. Unterstützte Kontotypen: **Nur Konten in diesem Organisationsverzeichnis**.
   Umleitungs-URI: leer lassen. *Registrieren*.
3. Auf der Übersichtsseite notieren: **Anwendungs-ID (Client)** und **Verzeichnis-ID (Mandant)**.
4. *Zertifikate & Geheimnisse → Neuer geheimer Clientschlüssel*: Beschreibung und Laufzeit wählen, *Hinzufügen*, die Spalte
   **Wert** sofort kopieren (sie wird nur einmal angezeigt). **Ablaufdatum im Kalender vormerken** – danach scheitert jeder Versand,
   bis ein neuer Schlüssel in n8n eingetragen ist.

### 1.2 Berechtigung erteilen – zwei Wege

Der Workflow braucht für die Postfächer der Benutzer **Mail.ReadWrite** (Entwurf mit Anhängen anlegen) und **Mail.Send** (senden),
jeweils als **Anwendungsberechtigung**.

**Weg A – auf bestimmte Postfächer begrenzt (empfohlen).** Die Berechtigung wird nicht in Entra, sondern in Exchange Online
vergeben und gilt nur für die Mitglieder einer Gruppe („RBAC for Applications“,
[Microsoft Learn](https://learn.microsoft.com/graph/auth-limit-mailbox-access)):

1. Eine E-Mail-aktivierte Sicherheitsgruppe (oder Microsoft-365-Gruppe) anlegen, z. B. „Euroflex Versandpostfächer“, und die
   Benutzer aufnehmen, die aus dem Portal senden. Nur direkte Mitglieder zählen.
2. In Entra unter *Unternehmensanwendungen* die App öffnen und **Anwendungs-ID** und **Objekt-ID** von dieser Seite notieren
   (nicht die Objekt-ID der Seite *App-Registrierungen* – das ist ein anderer Wert).
3. In der Exchange-Online-PowerShell als Exchange-Administrator:

   ```powershell
   Connect-ExchangeOnline
   New-ServicePrincipal -AppId <Anwendungs-ID> -ObjectId <Objekt-ID der Unternehmensanwendung> -DisplayName "n8n Euroflex Mailversand"
   Get-Group "Euroflex Versandpostfächer" | Format-List DistinguishedName
   New-ManagementScope -Name "Euroflex Versandpostfaecher" -RecipientRestrictionFilter "MemberOfGroup -eq '<DistinguishedName der Gruppe>'"
   New-ManagementRoleAssignment -App <Anwendungs-ID> -Role "Application Mail.ReadWrite" -CustomResourceScope "Euroflex Versandpostfaecher"
   New-ManagementRoleAssignment -App <Anwendungs-ID> -Role "Application Mail.Send" -CustomResourceScope "Euroflex Versandpostfaecher"
   Test-ServicePrincipalAuthorization -Identity "n8n Euroflex Mailversand" -Resource <postfach@firma>
   ```

   Der letzte Befehl muss für ein Postfach der Gruppe `InScope: True` zeigen.
4. In Entra unter *API-Berechtigungen* für diese App **keine** Mail-Berechtigung erteilen: Entra- und Exchange-Berechtigungen
   addieren sich, eine in Entra erteilte Berechtigung gilt für **alle** Postfächer und hebt die Begrenzung auf.
5. Änderungen wirken laut Microsoft nach 30 Minuten bis 2 Stunden.

**Weg B – ohne Begrenzung (einfacher, aber die App darf dann aus jedem Postfach des Mandanten lesen und senden).**
*App-Registrierungen → die App → API-Berechtigungen → Berechtigung hinzufügen → Microsoft Graph → Anwendungsberechtigungen*:
`Mail.ReadWrite` und `Mail.Send` wählen, danach **Administratorzustimmung erteilen**. Nur vertretbar, wenn der Mandant
ausschließlich Postfächer enthält, die ohnehin über das Portal senden dürfen.

## 2 Zugangsdaten in n8n

Beide Zugangsdaten stehen nur in n8n; die Workflow-Datei im Repository enthält keine.

**Microsoft Graph** – *Credentials → Create credential → „OAuth2 API“* (der allgemeine Typ, nicht „Microsoft Outlook OAuth2 API“):

| Feld | Wert |
|---|---|
| Name | `Euroflex Microsoft Graph` |
| Grant Type | **Client Credentials** |
| Access Token URL | `https://login.microsoftonline.com/<Verzeichnis-ID>/oauth2/v2.0/token` |
| Client ID | Anwendungs-ID aus 1.1 |
| Client Secret | Wert des Clientschlüssels aus 1.1 |
| Scope | `https://graph.microsoft.com/.default` |
| Authentication | Body |

**Webhook-Schlüssel** – *Credentials → Create credential → „Header Auth“*: Name der Zugangsdatei `Euroflex Webhook-Schlüssel`,
Feld **Name** = `X-Euroflex-Key`, Feld **Value** = ein selbst gewähltes langes Geheimnis (z. B. `openssl rand -hex 32`).

## 3 Workflow importieren und eintragen

1. *Workflows → Import from File* → `euroflex-mailversand.json`.
2. Knoten **Webhook Portal**: unter *Credential for Header Auth* „Euroflex Webhook-Schlüssel“ wählen.
3. Knoten **Postfach prüfen**, **Entwurf anlegen** und **Senden**: unter *OAuth2 API* jeweils „Euroflex Microsoft Graph“ wählen.
4. Speichern, Workflow **aktivieren**.

Nach jedem erneuten Import sind die Schritte 2 und 3 zu wiederholen. Im Workflow selbst ist nichts weiter einzutragen: Absender,
Empfänger, feste zweite Adresse und Anhänge kommen mit jedem Aufruf aus dem Portal.

## 4 Im Portal eintragen

*Administration → Schnittstellen → Anbindungen → Euroflex E-Mail-Versand (Outlook 365, n8n)* (Recht `core.settings:edit`):

| Feld | Wert |
|---|---|
| Webhook-URL | `http://n8n:5678/webhook/euroflex-mailversand` (Production-URL, nicht `/webhook-test/`) |
| Anmeldung | Schlüssel im eigenen Header, Header-Name `X-Euroflex-Key` |
| Webhook-Schlüssel | derselbe Wert wie in der n8n-Zugangsdatei |
| Feste zweite Adresse | genau eine Adresse; sie erhält jede E-Mail parallel als eigene E-Mail. Leer = keine zweite E-Mail |
| Postfach je Benutzer | `benutzername=adresse`, mehrere durch Komma, z. B. `mmuster=m.muster@firma.de, bbeispiel=b.beispiel@firma.de`. Ohne Eintrag gilt die E-Mail-Adresse, die am Portal-Benutzer hinterlegt ist |
| Höchstgröße der Anhänge | MB je Vorgang, Standard 10, höchstens 25 |

Danach:

1. **„Verbindung prüfen“** – meldet Erreichbarkeit, Workflow, Schlüssel und ob Microsoft 365 das Postfach **Ihres** Benutzers
   freigibt. Es wird keine E-Mail gesendet.
2. **Probeversand:** an einem Testauftrag „E-Mail mit Anhängen…“ öffnen, als Empfänger die eigene Adresse eintragen, zwei
   Anhänge wählen, zuerst **„Entwurf in Outlook“** (die Entwürfe müssen mit Anhängen im Postfach liegen), dann **„Senden“**.
3. Mit dem größten üblichen Anhang wiederholen (Foto, Scan), siehe *Größe der Anhänge*.

## Bedienung

Im Dialog *E-Mail mit Anhängen…* (Recht `transport.versand:execute`):

- **Senden** – beide E-Mails gehen sofort hinaus. Die Zeile unter den Anhängen nennt das Postfach und die feste zweite Adresse.
- **Entwurf in Outlook** – dieselben E-Mails landen als Entwürfe im Postfach und werden in Outlook geprüft und gesendet.
- **E-Mail-Datei** – der bisherige Weg (`.eml` für das Mailprogramm auf dem PC), unabhängig von n8n.
- Schlägt nur eine der beiden E-Mails fehl, nennt die Meldung, welche erledigt ist. Der Knopf heißt dann **„Rest senden“** und
  sendet nur die fehlgeschlagene – niemand bekommt etwas doppelt.
- Jede E-Mail steht in *Administration → Protokolle → E-Mail-Protokoll* (Anwendung „Euroflex“, Vorgang = Auftragsnummer, Absender = Postfach).
  Der Inhalt wird nicht gespeichert; „Erneut senden“ aus dem Protokoll gibt es für diese E-Mails nicht – wiederholt wird am Auftrag.
- Ohne eingerichtete Anbindung zeigt der Dialog nur den bisherigen Entwurf.

## Aufruf (Portal → n8n)

`POST …/webhook/euroflex-mailversand`, Header `X-Euroflex-Key`.

```json
{
  "modus": "senden",                       // oder "entwurf" (nur Entwürfe im Postfach), "pruefen" (Verbindungstest)
  "anwendung": "Euroflex", "objekt": "2026_0153", "benutzer": "Max Muster",
  "absender": "m.muster@firma.de",         // Postfach, aus dem gesendet wird
  "anhaenge": [                            // jede Datei einmal
    { "id": "a1", "dateiname": "Lieferschein_2026_0153.pdf", "mime": "application/pdf", "inhalt_base64": "…" }
  ],
  "mails": [                               // beliebig viele E-Mails zum selben Vorgang (höchstens 20)
    { "nr": 1, "rolle": "kunde", "an": ["kunde@example.org"], "cc": [], "bcc": [],
      "betreff": "Lieferschein 2026_0153", "text": "…", "text_format": "text", "anhaenge": ["a1"] },
    { "nr": 2, "rolle": "kopie", "an": ["ablage@firma.de"],
      "betreff": "Lieferschein 2026_0153", "text": "…", "text_format": "text", "anhaenge": ["a1"] }
  ]
}
```

Antwort: `{ "status": "gesendet" | "entwurf" | "teilweise" | "fehler", "postfach", "zeitpunkt", "fehler",
"mails": [{ "nr", "rolle", "an", "status", "message_id", "fehler" }] }`. Ungültige Aufrufe (kein Empfänger, ungültige Adresse,
unbekannte Anhang-Kennung, leere Datei) beantwortet der Workflow mit HTTP 400, ohne etwas anzulegen.
`an`, `cc`, `bcc` und `antwort_an` nehmen eine Liste oder Text mit Komma/Semikolon, auch `Name <adresse>`.

## Aufbau

| Knoten | Aufgabe |
|---|---|
| Webhook Portal | nimmt den Aufruf an (Header Auth), Antwort erst durch einen Antwort-Knoten |
| Aufruf prüfen · Gültig? · Antwort ungültig | Felder, Adressen und Anhang-Kennungen prüfen; sonst HTTP 400 |
| Nur prüfen? · Postfach angegeben? · Postfach prüfen · Antwort Prüfung | Verbindungstest: liest den Ordner „Entwürfe“ des Postfachs, sendet nichts |
| E-Mails aufteilen | je E-Mail ein Element mit der Nachricht für Microsoft Graph, Anhänge aus dem gemeinsamen Vorrat |
| Entwurf anlegen | `POST /users/{postfach}/messages` – Entwurf samt Anhängen |
| Entwürfe auswerten · Etwas zu senden? | Ergebnis je E-Mail; genau **ein** Element, damit der Versand nur einmal läuft |
| Sendbare aufteilen · Senden | `POST /users/{postfach}/messages/{id}/send` je angelegtem Entwurf |
| Ergebnis · Antwort | Status je E-Mail und Gesamtstatus an das Portal |

- Die Graph-Knoten brechen bei einer Ablehnung nicht ab („Never Error“): Scheitert eine E-Mail, wird sie als `fehler` gemeldet
  und die andere trotzdem verarbeitet. Eine automatische Wiederholung gibt es bewusst nicht – sie könnte E-Mails doppelt senden.
- n8n arbeitet die E-Mails eines Aufrufs nacheinander im selben Lauf ab; sie gehen innerhalb weniger Sekunden hinaus.
- Scheitert erst das Senden, bleibt der Entwurf im Postfach liegen (die Meldung sagt das) und kann dort gesendet oder gelöscht werden.

## Größe der Anhänge

- Jede E-Mail wird mit ihren Anhängen in **einem** Aufruf an Microsoft Graph übergeben. Microsoft dokumentiert das für Dateien
  **unter 3 MB**; für 3 bis 150 MB sieht die Dokumentation eine Upload-Sitzung vor
  ([Microsoft Learn](https://learn.microsoft.com/en-us/graph/outlook-large-attachments)), die dieser Workflow **nicht** verwendet.
  Größere Dateien funktionieren nach Berichten aus der Praxis inzwischen auch direkt – das zeigt der Probeversand. Lehnt Microsoft
  ab, meldet das Portal den Fehler von Microsoft; dann die Höchstgröße in der Anbindung senken oder die Upload-Sitzung nachrüsten.
- Anhänge reisen als Base64 (ein Drittel größer). n8n nimmt Webhook-Aufrufe bis 16 MiB an
  ([n8n-Dokumentation](https://docs.n8n.io/hosting/configuration/environment-variables/endpoints/)); das reicht für die
  voreingestellten 10 MB. Für mehr `N8N_PAYLOAD_SIZE_MAX` in der `.env` erhöhen (z. B. `48` für 25 MB) und n8n neu starten.

## Fehlersuche

| Meldung im Portal | Ursache |
|---|---|
| „n8n hat den Webhook-Schlüssel abgelehnt“ | Wert im Portal ≠ Wert der Zugangsdatei, oder deren Feld *Name* ist nicht `X-Euroflex-Key` |
| „… nicht aktiv oder die URL stimmt nicht“ | Workflow nicht aktiviert oder Test-URL eingetragen |
| „Entwurf anlegen fehlgeschlagen (HTTP 401)“ | Zugangsdatei „Euroflex Microsoft Graph“ falsch oder Clientschlüssel abgelaufen |
| „… (HTTP 403)“ / „… (HTTP 404)“ | Postfach liegt nicht in der Gruppe aus Weg A, Rollenzuweisung noch nicht wirksam (bis 2 Stunden) oder Postfach gibt es nicht |
| „Für Ihren Benutzer ist kein Postfach hinterlegt“ | weder Zuordnung in der Anbindung noch E-Mail-Adresse am Portal-Benutzer |
| „… (HTTP 413)“ oder Abbruch bei großen Dateien | siehe *Größe der Anhänge* |

In n8n zeigt *Executions* jeden Lauf mit der Antwort von Microsoft. Die Läufe enthalten Text und Anhänge der E-Mails; wer das
nicht speichern möchte, stellt in den Workflow-Einstellungen *Save successful production executions* auf „Do not save“.

## Später: Paperless Custom Field

Heute zeigt der Dialog die Dateien des Ablageordners und die Paperless-Dokumente, die das Portal dem Auftrag zugeordnet hat.
Die Auswahl über ein Custom Field „Auftragsnummer“ in Paperless ist ein eigener Schritt im Portal; Workflow und Aufrufformat
ändern sich dafür nicht, weil das Portal die Dateien immer fertig übergibt.
