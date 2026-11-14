<!-- Automatisch erzeugt von scripts/landschaft.mjs – nicht von Hand ändern. Quelle der Prozesse: docs/landschaft/prozesse.json -->
# Level 1 – Systemlandschaft

Aufbau wie die SAP-BTP-Referenzarchitektur: ① Anmeldung, ② Anbindungen, ③ Portal mit Fachbereichen, ④ Vereinssysteme hinter der Firewall, ⑤ Laufzeit.

```mermaid
flowchart LR
  subgraph CLIENT["Endnutzer · Client-Zugang"]
    BROWSER["Browser"]
    PHONE["Smartphone"]
    OEFF["Öffentliche Seiten<br/>/beitritt · /schnuppertraining · /registrierung-bestaetigen · /einladung · /schluessel-quittung"]
  end
  subgraph STACK["Heimserver · Docker-Stack (Portainer)"]
    subgraph PORTAL["3 · Vereinsportal – Modul tco"]
      B_Allgemein["<b>Allgemein</b><br/>Vereinsübersicht<br/>Präsentationen<br/>Vereinskalender"]
      B_MeinBereich["<b>Mein Bereich</b><br/>Meine Mitgliedschaft<br/>Meine Daten<br/>Platz buchen<br/>Mein Verzehr<br/>Meine Trainingszeiten<br/>Schaden melden"]
      B_Einstellungen["<b>Einstellungen</b><br/>Kontenstamm<br/>Produkte"]
      B_Mitglieder["<b>Mitglieder</b><br/>Mitglieder<br/>Mitgliedergruppen<br/>Mitgliedsanträge<br/>Registrierungen<br/>Mitgliedsbeiträge<br/>Mitglieder-Analyse"]
      B_Sport["<b>Sport</b><br/>Spielerdaten (nuLiga)"]
      B_Jugend["<b>Jugend</b><br/>Teilnehmer Jugendtraining<br/>Schnuppertraining<br/>Abrechnung Jugendtraining"]
      B_Tennishalle["<b>Tennishalle</b><br/>Hallenpreise<br/>Hallenabrechnung<br/>Hallenschlüssel<br/>Serienbuchung<br/>Platzverwaltung"]
      B_Clubhaus["<b>Clubhaus</b><br/>Clubhausabrechnung<br/>Theke<br/>Verzehrbuch"]
      B_Instandhaltung["<b>Instandhaltung</b><br/>Schadensmeldungen"]
      B_Finanzen["<b>Finanzen</b><br/>Sollstellungen<br/>FI-Belege<br/>Beitragsforecast<br/>Einnahmen und Ausgaben<br/>Jahresabschluss"]
      B_Dokumente["<b>Dokumente</b><br/>Dokumenteneingang<br/>Dokumenten-Upload"]
    end
    AUTH["1 · Anmeldung & Rollen<br/>core.users · Sessions"]
    ANB["2 · Anbindungen<br/>Rückmeldungen Jugendtraining (n8n)<br/>Schulferien Saarland (n8n)<br/>EP3-Export Hallenbuchungen (n8n)<br/>Maileingang jetzt abrufen (n8n)<br/>Paperless-ngx TC Oberthal<br/>E-Mail-Versand (n8n)<br/>Nextcloud<br/>Euroflex E-Mail-Versand (Outlook 365, n8n)<br/>Paperless-ngx Euroflex"]
    RT["5 · Laufzeit<br/>db · gotenberg · backup · caddy · paperless-db · paperless-redis · paperless-tika · paperless · n8n"]
    N8N["n8n<br/>Euroflex Mailversand<br/>TCO EP3 Import Portal<br/>TCO Maileingang<br/>TCO Mailversand<br/>TCO Paperless Qualifizierung"]
    PL[("Paperless-ngx")]
  end
  subgraph EXT["4 · Vereinssysteme"]
    EP3[("EP3-bs")]
    MAIL["Mailserver IMAP/SMTP"]
    NC["Nextcloud WebDAV"]
    BANK["Bank (Dateien)"]
    SAP["SAP (Altsystem)"]
  end
  subgraph CLOUD["Externe Cloud-Dienste"]
    OAI["OpenAI API"]
    LIGA["liga.nu"]
  end
  BROWSER --> PORTAL
  PHONE --> PORTAL
  OEFF --> PORTAL
  CLIENT -. Anmeldung .-> AUTH
  AUTH -- trust --- PORTAL
  PORTAL <--> ANB
  ANB -- Webhooks --> N8N
  PORTAL -- REST --> PL
  N8N -- "MySQL (lesend)" --> EP3
  N8N -- "IMAP" --> MAIL
  N8N -- "HTTP" --> PORTAL
  N8N -- "SMTP" --> MAIL
  N8N -- "HTTP" --> PL
  N8N -- "HTTP" --> OAI
  PORTAL -- WebDAV --> NC
  BANK -. CSV / pain.008 .- PORTAL
  SAP -. ZIP/CSV .-> PORTAL
  LIGA -. Spielplan .-> PORTAL
  classDef portal fill:#ffffff,stroke:#1f5fa8,stroke-width:2px,color:#1f5fa8
  classDef n8n fill:#ffffff,stroke:#2e7d32,stroke-width:2px,color:#2e7d32
  classDef extern fill:#ffffff,stroke:#2a9d8f,stroke-width:2px,color:#1d6f66
  classDef person fill:#ffffff,stroke:#7f7f7f,stroke-width:2px,stroke-dasharray:4 3,color:#404040
  class PORTAL,AUTH,ANB,RT portal
  class N8N n8n
  class EP3,MAIL,NC,BANK,SAP,OAI,LIGA,PL extern
```

## Bereiche und Apps

| Bereich | App | Pfad | Berechtigung | Zweck |
|---|---|---|---|---|
| Allgemein | Vereinsübersicht | `/tco/uebersicht` | `tco.dashboard:display` | Kennzahlen Mitglieder, Clubhaus, Finanzen, Jugend, Halle, Instandhaltung |
| Allgemein | Präsentationen | `/tco/praesentationen` | `tco.praesentation:display` |  |
| Allgemein | Vereinskalender | `/tco/kalender` | `tco.kalender:anmelden\|tco.kalender:edit` | Veranstaltungen, Mannschaften, An- und Abmeldung |
| Mein Bereich | Meine Mitgliedschaft | `/tco/meine-mitgliedschaft` | `tco.meinedaten:edit` | Eigene Daten, Bankverbindung, Verträge, Kündigung |
| Mein Bereich | Meine Daten | `/tco/meine-daten` | `tco.meinkonto:edit` | Anschrift, E-Mail und Telefon pflegen |
| Mein Bereich | Platz buchen | `/tco/platz-buchen` | `tco.platzbuchung:edit` | Freiplätze und Halle – eigene Buchungen mit Preisen |
| Mein Bereich | Mein Verzehr | `/tco/verzehr` | `tco.verzehr:edit` | Verzehr im Clubhaus auf das eigene Konto anschreiben |
| Mein Bereich | Meine Trainingszeiten | `/tco/meine-zeiten` | `tco.jtmeine:edit` | Eigene Zeiten zurückmelden, Zeitnachweise ansehen |
| Mein Bereich | Schaden melden | `/tco/schaden` | `tco.schaden:melden` | Etwas kaputt auf der Anlage? Mit Foto melden |
| Einstellungen | Kontenstamm | `/tco/konten` | `tco.konten:display` | Konten, Verwendung je Jahr, Anfangsbestände |
| Einstellungen | Produkte | `/tco/produkte` | `tco.produkte:display` | Produkte, Preise je Zeitraum, Erlöskonten |
| Mitglieder | Mitglieder | `/tco/mitglieder` | `tco.mitglieder:display` | Stammdaten, Verträge, SEPA, Unterlagen |
| Mitglieder | Mitgliedergruppen | `/tco/gruppen` | `tco.gruppen:display` | Kategorien, Gruppen und Mannschaften im Baum |
| Mitglieder | Mitgliedsanträge | `/tco/mitgliedsantraege` | `tco.antraege:display` |  |
| Mitglieder | Registrierungen | `/tco/registrierungen` | `tco.registrierung:mitglied` |  |
| Mitglieder | Mitgliedsbeiträge | `/tco/beitraege` | `tco.beitraege:display` | Beitragsarten und Beträge je Zeitraum |
| Mitglieder | Mitglieder-Analyse | `/tco/analyse` | `tco.analyse:display` | Altersstruktur, Ein-/Austritte, Beiträge, Varianten |
| Sport | Spielerdaten (nuLiga) | `/tco/spielerdaten` | `tco.sport:display` | ID-Nr. und LK aus der Verbandsliste abgleichen |
| Jugend | Teilnehmer Jugendtraining | `/tco/teilnehmer` | `tco.teilnehmer:display` | Trefferliste, Mitglieder/Nichtmitglieder, E-Mail |
| Jugend | Schnuppertraining | `/tco/schnuppertraining` | `tco.schnupper:display` | Anmeldungen, Einheiten, Beitrittslink |
| Jugend | Abrechnung Jugendtraining | `/tco/jugendtraining` | `tco.jt:display` | Trainingszeiten, Zeitnachweise, Trainerentgelte |
| Tennishalle | Hallenpreise | `/tco/hallenpreise` | `tco.halle:display` | Produkte und Preismatrix |
| Tennishalle | Hallenabrechnung | `/tco/halle` | `tco.halle:display` | EP3-Buchungen abrechnen |
| Tennishalle | Hallenschlüssel | `/tco/hallenschluessel` | `tco.schluessel:display` |  |
| Tennishalle | Serienbuchung | `/tco/serienbuchung` | `tco.platz:serie` | Hallenwart: mehrere Plätze, Stunden, Abos |
| Tennishalle | Platzverwaltung | `/tco/platzverwaltung` | `tco.platz:admin` | Plätze, Buchungsregeln, Belegung, Abos |
| Clubhaus | Clubhausabrechnung | `/tco/clubhaus` | `tco.clubhaus:display` | Getränkerechnungen, Forderungsliste, Absatz |
| Clubhaus | Theke | `/tco/theke` | `tco.verzehr:theke` | Gäste kassieren, Belege senden, Mitglieder anschreiben |
| Clubhaus | Verzehrbuch | `/tco/verzehrbuch` | `tco.verzehr:display` | Alle Positionen, Belege, Monatsabschluss, Preisliste |
| Instandhaltung | Schadensmeldungen | `/tco/instandhaltung` | `tco.instandhaltung:display` | Meldungen bearbeiten, Plätze sperren |
| Finanzen | Sollstellungen | `/tco/sollstellung` | `tco.soll:display` | Beitragseinzug per SEPA-Lastschrift |
| Finanzen | FI-Belege | `/tco/fi` | `tco.fi:display` | Bankimport, Belege, Storno |
| Finanzen | Beitragsforecast | `/tco/forecast` | `tco.forecast:display` | Hochrechnung der Beitragseinnahmen |
| Finanzen | Einnahmen und Ausgaben | `/tco/finanz` | `tco.finanz:display` | Jahresübersicht, Geldkonten, Liquidität |
| Finanzen | Jahresabschluss | `/tco/abschluss` | `tco.abschluss:display` | EAR, Vermögensübersicht, Anlagevermögen |
| Dokumente | Dokumenteneingang | `/tco/dokumenteneingang` | `tco.eingang:display` | E-Mails und Anhänge nach Regeln ablegen, Prüfliste |
| Dokumente | Dokumenten-Upload | `/tco/upload` | `tco.upload:execute` | Belege gesammelt nach Paperless |

**Öffentliche Seiten (ohne Anmeldung):** `/beitritt`, `/schnuppertraining`, `/registrierung-bestaetigen`, `/einladung`, `/schluessel-quittung`

## Schnittstellen (n8n-Workflows)

| Workflow | Auslöser | Ziel | Art | Knoten | Detail |
|---|---|---|---|---|---|
| Euroflex Mailversand | Webhook /webhook/euroflex-mailversand | extern | HTTP | Postfach prüfen, Entwurf anlegen, Senden | https://graph.microsoft.com/v1.0/users/{{ encodeURIComponent |
| TCO EP3 Import Portal | Webhook /webhook/tco-ep3-import | EP3-bs Hallenbuchung | MySQL (lesend) | EP3 Buchungen, EP3 Kunden, EP3 Texte, EP3 Events |  |
| TCO Maileingang | manuell (Editor), Webhook /webhook/tco-dokumenteneingang-alle, Zeitplan alle 5 Min. | Mailserver (IMAP/SMTP) | IMAP | Posteingang lesen (IMAP), Posteingang lesen (IMAP Benjamin), Anhänge laden, Als gelesen markieren, E-Mail verschieben, E-Mail in den Papierkorb |  |
| TCO Maileingang | manuell (Editor), Webhook /webhook/tco-dokumenteneingang-alle, Zeitplan alle 5 Min. | Vereinsportal (Modul tco) | HTTP | An Portal liefern, Ausstehende Mailaktionen, Erledigt melden | /api/m/tco/eingang/mail, /api/m/tco/eingang/mailaktionen, /api/m/tco/eingang/vorgaenge/ |
| TCO Mailversand | Webhook /webhook/tco-mailversand | Mailserver (IMAP/SMTP) | SMTP | E-Mail senden (SMTP), E-Mail senden (SMTP Benjamin) |  |
| TCO Mailversand | Webhook /webhook/tco-mailversand | Mailserver (IMAP/SMTP) | IMAP | Entwurf ablegen (IMAP) |  |
| TCO Paperless Qualifizierung | Webhook /webhook/tco-paperless-qualifizieren, Zeitplan alle 30 Min., manuell (Editor) | Paperless-ngx | HTTP | Custom Fields laden, Korrespondenten laden, Dokumenttypen laden, Offene Dokumente suchen, Dokument laden, Datei laden, Dokument aktualisieren | /api/custom_fields, /api/correspondents, /api/document_types, /api/documents |
| TCO Paperless Qualifizierung | Webhook /webhook/tco-paperless-qualifizieren, Zeitplan alle 30 Min., manuell (Editor) | OpenAI API | HTTP | OpenAI Analyse | https://api.openai.com/v1/chat/completions |

## Anbindungen im Portal (Administration → Schnittstellen → Anbindungen)

| Kennung | Bezeichnung | n8n-Workflow | Beschreibung | Quelle |
|---|---|---|---|---|
| `tco.stunden` | Rückmeldungen Jugendtraining (n8n) |  | Liest die Stundenrückmeldungen der Trainer aus Nextcloud über den n8n-Webhook TCO_N8N_STUNDEN. Anmeldung am Webhook mit Benutzer und Passwort, sofern n8n sie verlangt. | `modules/tco/server/verbindung.ts` |
| `tco.ferien` | Schulferien Saarland (n8n) |  | Ferien und Feiertage je Jahr über den n8n-Webhook ferien-saarland. Anmeldung wie bei den Rückmeldungen. | `modules/tco/server/verbindung.ts` |
| `tco.ep3` | EP3-Export Hallenbuchungen (n8n) | TCO EP3 Import Portal | Übernahme der Hallenbuchungen und Kunden aus dem EP3-Buchungssystem über n8n. Der Test ruft den Export ab, übernimmt aber nichts. | `modules/tco/server/verbindung.ts` |
| `tco.mailabruf` | Maileingang jetzt abrufen (n8n) | TCO Maileingang | Startet im Dokumenteneingang über „Posteingang abrufen“ den n8n-Workflow „TCO Maileingang“ (Webhook-Knoten „Alle Mails jetzt (Webhook)“,  | `modules/tco/server/verbindung.ts` |
| `paperless` | Paperless-ngx TC Oberthal |  | Dokumentenablage für TC Oberthal – ein eigenes Paperless je Bereich, nie dieselbe Adresse wie ein anderer Bereich. | `modules/tco/server/verbindung.ts` |
| `mail` | E-Mail-Versand (n8n) | TCO Mailversand | Generischer n8n-Workflow „TCO Mailversand“ für alle E-Mails des Portals (Kennwort-Links, Registrierung, Rechnungen, Mitglieder …).  | `server/src/lib/mail.ts` |
| `nextcloud` | Nextcloud |  | Ein Zugang für alles, was das Portal in der Nextcloud ablegt (WebDAV): die tägliche Sicherung (Administration → System → Sicherung) und die Arbeitsablage des Dokumenteneingangs.  | `server/src/lib/nextcloud.ts` |
| `transport.mail` | Euroflex E-Mail-Versand (Outlook 365, n8n) | Euroflex Mailversand | n8n-Workflow „Euroflex Mailversand“: E-Mails zum Auftrag mit ausgewählten Anhängen über Outlook 365, aus dem Postfach des angemeldeten Benutzers.  | `modules/transport/server/mailversand.ts` |
| `transport.paperless` | Paperless-ngx Euroflex |  | Dokumentenablage für Euroflex – ein eigenes Paperless je Bereich, nie dieselbe Adresse wie ein anderer Bereich. | `modules/transport/server/mailversand.ts` |

> Hinweis: Zu „Rückmeldungen Jugendtraining (n8n)“, „Schulferien Saarland (n8n)“ liegt kein Workflow-Export in `docs/n8n` – die Workflows existieren nur in der n8n-Instanz.

## Container (docker-compose.yml)

| Dienst | Image | Profil |
|---|---|---|
| db | `postgres:16-alpine` | immer |
| gotenberg | `gotenberg/gotenberg:8` | immer |
| app | `${COMPOSE_PROJECT_NAME:-portal}-app:latest` | immer |
| backup | `postgres:16-alpine` | immer |
| caddy | `caddy:2-alpine` | https |
| paperless-db | `postgres:16-alpine` | paperless |
| paperless-redis | `redis:7-alpine` | paperless |
| paperless-tika | `apache/tika:latest` | paperless |
| paperless | `ghcr.io/paperless-ngx/paperless-ngx:latest` | paperless |
| n8n | `docker.n8n.io/n8nio/n8n:latest` | n8n |

## API-Routen je Ordner

| Ordner | Routen |
|---|---|
| abschluss | 9 |
| analyse | 7 |
| antrag | 13 |
| beitraege | 8 |
| clubhaus | 18 |
| core:admin | 17 |
| core:apikeys | 6 |
| core:arbeitsvorrat | 2 |
| core:audit | 3 |
| core:auth | 7 |
| core:backup | 15 |
| core:funktionen | 2 |
| core:mail | 8 |
| core:paperless | 5 |
| core:settings | 3 |
| core:setup | 2 |
| core:sperren | 5 |
| core:statistik | 3 |
| core:tabellen | 8 |
| core:varianten | 3 |
| core:verbindungen | 3 |
| core:weltenwandler | 2 |
| dashboard | 9 |
| eingang | 29 |
| fi | 30 |
| finanz | 3 |
| forecast | 1 |
| gruppen | 9 |
| halle | 41 |
| index | 6 |
| instandhaltung | 34 |
| jt | 30 |
| kalender | 23 |
| konten | 5 |
| mitglieder | 72 |
| platz | 67 |
| praesentation | 11 |
| produkte | 6 |
| schluessel | 28 |
| schnupper | 6 |
| soll | 12 |
| sport | 4 |
| teilnehmer | 4 |
| upload | 2 |
| verzehr | 29 |
