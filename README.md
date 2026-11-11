# Portalbasis

Self-hosted Web-Portal im SAP-Fiori-Look – ohne SAP-Basis.
Die Basis enthält alles, was jede Anwendung braucht; die Fachlichkeit kommt als **Modul** dazu
(z. B. `tco` für den Verein, `transport` für ein Transportwesen). Beide Projekte nutzen dieselbe Basis,
jede Installation schaltet nur ihre Module ein.

| Bereich | Inhalt |
|---|---|
| Oberfläche | React + **UI5 Web Components** (SAP Horizon, Open Source), Shell mit Seitennavigation, Startseite mit Kacheln |
| Anmeldung | Benutzer/Passwort (Argon2), Sitzungen, Sperre nach Fehlversuchen, Passwortwechsel beim ersten Login; **„Passwort vergessen?“** mit Einmal-Link (60 Min., nur einmal, nur Hash gespeichert, beendet alle Sitzungen); Benutzeranlage wahlweise mit **Einmal-Link „Kennwort festlegen“** (48 Std.) statt Startkennwort – Links nutzen die Portal-Adresse aus den Einstellungen |
| Berechtigungen | Rollen aus Berechtigungen „Objekt:Aktivität“, Module bringen ihre Berechtigungen selbst mit; Seitenleiste, Startseite und Seiten zeigen nur, wofür der Benutzer berechtigt ist – Rollenänderungen wirken in offenen Sitzungen ohne Neuanmeldung (Abgleich bei „Keine Berechtigung“, beim Zurückkehren in den Tab und jede Minute); Rollen lassen sich für einen **Zeitraum deaktivieren** (von/bis, bis leer = unbefristet, mit Grund) – dann gewähren sie keinem Benutzer Berechtigungen, die Zuordnungen bleiben erhalten und wirken nach Ablauf automatisch wieder (Administratorrolle ausgenommen) |
| Änderungsbelege | wie CDHDR/CDPOS, per Datenbank-Trigger – lückenlos, unveränderlich, mit Benutzer, Aktion und Begründung |
| Registrierung | Auswahl **Mitglied** (Nachweis Geburtsdatum oder Mitgliedsnummer, Freigabe durch den Kassenwart mit Vorschlag im Arbeitsvorrat, Rolle „Mitglied“) oder **externer Hallennutzer** (E-Mail-Bestätigung, danach sofort freigeschaltet; ohne Mailversand Freigabe durch die Platzverwaltung mit Zuordnung zu Mitglied/EP3-Kunde), Rolle „Hallennutzer“ (Vorgabe: nur Einzelbuchung und eigene Daten; Berechtigungen ändert nur ein Administrator, keine Administrationsrechte), Übernahme der EP3-Kennwörter (bcrypt aus bs_users.pw, Kundenexport mit Spalte PW); der Kundenimport legt für alle aktiven EP3-Kunden Hallennutzer an (Anmeldename = E-Mail, „Nachname, Vorname“, Zuordnung zu Mitgliedern über ZUID/E-Mail/Name); Anmeldung mit Benutzername oder E-Mail **Ablauf in Schritten (#10):** 1 Mitglied oder externer Hallennutzer · 2 E-Mail (Mitglied: zusätzlich Geburtsdatum) – `POST /platz/registrierung/pruefen` sucht im Mitglieder- bzw. Kundenstamm (genau ein Eintrag ohne Zugang; zurück kommen nur Vorname und Anfangsbuchstabe des Nachnamens) · bei einem Treffer entfällt die Eingabe von Name und Anschrift (`ausBestand`, der Server übernimmt sie aus dem Stamm), sonst Schritt „Ihre Angaben“ · 3 Benutzername (frei gewählt, nicht vorbelegt) und Kennwort · 4 Hinweis, wie es weitergeht: externe Hallennutzer bestätigen den Link in der E-Mail (das über die E-Mail gefundene bisherige Kundenkonto wird erst dann verknüpft), Mitglieder gibt der Vorstand frei. Die Abfrage nach dem bisherigen EP3-Konto und der frühere Schnellweg entfallen in der Oberfläche (die Endpunkte bleiben) |
| Feste Platzbelegungen | Jugendtraining, **Schnuppertraining** (#11, Migration `049_platzbelegung_schnupper.sql`), Sperrzeiten, Veranstaltungen (Platzverwaltung → Training & Sperrzeiten, EP3-Events per Import) – im Kalender für alle sichtbar, blockieren Buchungen; Kalender zeigt nur an dem Tag freigegebene Plätze |
| Platz buchen für Admin/Hallenwart (#11) | Recht `tco.platzbuchung:verwalten` (Rollenpflege → Tennishalle → Platz buchen, setzt `tco.platzbuchung:edit` voraus): im Kalender **Namen** (und Notiz, Einzel/Abo) fremder Buchungen; Training, Schnuppertraining, Veranstaltung farbig, Sperrzeit schraffiert. Ein freier Termin lässt sich über „Eintragen als“ buchen **für mich** (wie bisher, mit Preis und Buchungsregeln), **für ein Mitglied / eine Person** (Einzelbuchung wie die Serienbuchung „einmalig“: Mitglied mit Preis, vereinsintern ohne Rechnung; `POST /platz/verwalten/buchung`, Mitgliederauswahl `GET /platz/verwalten/mitglieder`) oder als **Training, Schnuppertraining, Sperrzeit, Veranstaltung** (feste Belegung für diesen Termin, Überschneidungen werden abgelehnt; `POST /platz/verwalten/belegung`). Ohne das Recht bleibt alles wie bisher (fremde Buchungen nur „belegt“) |
| Platzverwaltung → Belegung | 1, 3, 5 oder 7 Tage nebeneinander (je Tag und Platz eine Spalte; Auswahl wird im Browser gemerkt), Blättern um die gewählte Anzahl Tage. **Termin anklicken = ändern** (#11): Platz, Tag, Von/Bis und Notiz einer Portalbuchung (Einzel oder einzelner Abo-Termin; ohne Buchungsregeln, Preis neu, vereinsintern bleibt ohne Rechnung) bzw. eines eintägigen Trainings/Schnuppertrainings/Sperrzeit/Veranstaltung (Art, Bezeichnung, Hinweis); dort auch Stornieren/Löschen; der Tag wird schon beim Tippen (TT.MM.JJJJ) übernommen, Schnellwahl −1/+1/+7 Tage, ungültiges Datum sperrt „Speichern“. EP3-Buchungen, abgerechnete und wiederkehrende Belegungen nur ansehen (Pflege in EP3 bzw. „Training & Sperrzeiten“). **Kopier-Symbol je Termin** (oben rechts im Block): legt denselben Termin – gleiche Person bzw. gleicher vereinsinterner Name als Einzelbuchung, bei Training & Co. gleiche Art/Bezeichnung als Termin – auf Platz, Tag und Uhrzeit des Ziels an (Vorschlag: eine Woche später), auch von Abo- und EP3-Terminen; Überschneidungen werden abgelehnt (`PUT /platz/admin/buchung/:bid`, `POST /platz/admin/buchung/:bid/kopie` mit `alt_datum`, `PUT /platz/admin/belegung/:id`). **Freie Zeit anklicken = eintragen** (#11): Buchung für ein Mitglied (Preis laut Hallenpreisen) bzw. vereinsintern (ohne Rechnung) oder Training, Schnuppertraining, Sperrzeit, Veranstaltung für diesen Termin; Ende frei im Raster bis Öffnungsende, ohne Mindestdauer/Vorlauf, Überschneidungen werden abgelehnt (`POST /platz/admin/buchung`, `POST /platz/admin/belegung`, `tco.platz:admin`) |
| Meine Mitgliedschaft | Benutzerpflege: Status direkt in der Tabelle sperren, Filter aktiv/gesperrt, Einzelanlage aus Mitglied/EP3-Kunde; ausgetretene Mitglieder werden nach dem Austrittsdatum automatisch gesperrt. Selbstauskunft für Mitglieder (Rolle „Mitglied“, Berechtigungen nur durch Administratoren änderbar: eigene Daten, Bankverbindung, Kündigung zum Jahresende + Einzelbuchung); Administration → Benutzer legt alle aktiven Mitglieder als Benutzer an (Anmeldename = E-Mail, Startkennwort per Mail oder Liste); **„Mitglieder einladen (QR-Code)“** schickt aktiven Mitgliedern ohne Benutzer einen persönlichen Link mit QR-Code (30 Tage, einmal verwendbar, neue Einladung macht ältere ungültig) per E-Mail oder als Brief-PDF – Auswahlliste mit **Livesuche** (Name, Mitgliedsnummer, E-Mail; mehrere Begriffe werden UND-verknüpft), Filter „nur noch nicht eingeladene“, „alle wählen“/„keine“ wirken bei aktiver Suche nur auf die Treffer **Einladen & Zugangslinks** (Administration → Benutzer): Mitglieder ohne Benutzer per QR-Code einladen oder ausgewählten Personen einen Zugangslink senden – Namen einfügen (eine je Zeile, Tabelle „Name \| Anzahl“ oder kommagetrennt), Abgleich mit Benutzern (Anzeigename, Benutzername, verknüpftes Mitglied/EP3-Kunde) und Mitgliedern ohne Benutzer (erhalten die Einladung), Betreff und Text vorgeschlagen und änderbar mit Platzhaltern `{Vorname}` `{Name}` `{Benutzername}` `{Link}` `{GueltigBis}`, Gültigkeit 1–60 Tage, optional ein PDF als Anhang und Kopie (CC) an den Versender; auch die QR-Einladung zeigt Betreff und Text der E-Mail vorab und lässt sie ändern (`GET /mitglieder/einladungen/vorlage`, Platzhalter `{Vorname}` `{Name}` `{Link}` `{GueltigBis}`), ohne Vorauswahl, mit Filter „nur mit E-Mail-Adresse“ und Kopie an den Versender; `GET /mitglieder/zugang/vorlage`, `POST /mitglieder/zugang/abgleich`, `POST /mitglieder/zugang/senden` (`core.users:edit`) |
| Sperren | wie SM12: Objekt beim Öffnen zur Bearbeitung gesperrt (Typ + Schlüssel der Änderungsbelege), Durchsetzung im Datenbank-Trigger, Lebenszeichen, Ablauf nach 2 Min. bzw. 15 Min. Inaktivität, Platzzeiten schon bei Auswahl; Übersicht/Aufheben unter Administration → Sperren |
| Einstellungen | Organisationsname, Logo, Akzentfarbe, Anschrift, Portal-Adresse für Links in E-Mails |
| Anbindungen | angeschlossene Systeme an einer Stelle (Administration → Anbindungen, Tabelle `core.verbindungen`): Adresse, Anmeldeart (Token, Header, Basic Auth), Zugangsdaten maskiert, Verbindungstest, Änderungsbelege ohne Geheimnis. Der Kern meldet Paperless und den E-Mail-Versand (n8n, mit Ersatzabsendern je Anwendung, Mailprotokoll `core.mail_protokoll`, Testmail und „Erneut senden“) an, Module melden eigene Verbindungen über `ServerModule.verbindungen` (TCO: EP3-Export, Rückmeldungen, Ferien) und lesen sie mit `verbindungLesen(id)` |
| E-Mail-Versand | ein generischer n8n-Workflow für alle Mails (beliebige Inhalte und Anhänge, an/cc/bcc, Antwortadresse, Entwurf); **Absender ist, wer auf „Senden“ drückt** (Anfragekontext), Rückfall auf Ersatzabsender je Anwendung und Standard – siehe [E-Mail-Versand](#e-mail-versand-n8n) |
| E-Mail-Protokoll | App Administration → E-Mail-Protokoll (`core.mail:display`; je Zeile „Erneut senden“ mit Kopie an den Absender: `core.mail:edit`): alle E-Mails des Portals als Tabelle mit Filter (Suche nach Name, Adresse, Vorgang, Betreff; Anwendung, Status, Zeitraum), gesammelt je Person, Empfänger oder Vorgang. Die Person hinter einer Adresse kommt aus Benutzern und über `ServerModule.mailPersonen` aus den Modulen (TCO: Mitglieder, Hallenkunden, Registrierungen); der Inhalt wird nie angezeigt (`GET /api/mail/uebersicht`). **Rückmeldungen** aus den Postfächern der Absender (n8n-Workflow `docs/n8n/tco-maileingang.json` → `POST /api/m/tco/eingang/mail`, zusammen mit dem Dokumenteneingang): Unzustellbar-Meldungen des Mailservers (Status „unzustellbar“ mit Grund), Abwesenheitsnotizen und Antworten stehen an der gesendeten E-Mail |
| Dokumenteneingang | Modul TC Oberthal → Dokumente → Dokumenteneingang (`tco.eingang:display`/`edit`): n8n liefert eingegangene E-Mails samt Anhängen (`POST /api/m/tco/eingang/mail`, API-Schlüssel mit `tco.eingang:melden`), das Portal legt sie nach einem **pflegbaren Regelwerk** in Paperless und optional der Nextcloud ab (Bedingungen, Felder per Muster, Vorlagen mit Platzhaltern, Testlauf) und meldet n8n, was mit der E-Mail geschieht. Unklares steht in der **Prüfliste**; Inhalte bleiben nur bis zur Ablage im Portal, kein KI-Dienst – siehe [docs/dokumenteneingang.md](docs/dokumenteneingang.md) |
| PDF | HTML → PDF über Gotenberg (Layouts sind HTML-Templates); Module können PDFs auch selbst erzeugen (z. B. `transport`) |
| API-Schlüssel | Zugriff für Fremdsysteme (n8n, Webformulare) per `Authorization: Bearer …` – je Schlüssel genau ein Projekt/Modul mit ausgewählten Rechten |
| Nummernkreise | lückenlose Nummern je Objekt und Jahr (`core.next_number`) |
| Tabellenansicht | wie SE16: alle Tabellen von `core` und den aktiven Modulen mit Struktur und Inhalt, Selektion (Bedingungen, Felder, Sortierung), Gruppierung mit Kennzahlen, CSV – nur lesend, Geheimnisse nie sichtbar, siehe [Tabellenansicht](#tabellenansicht-administration) |
| Betrieb | Docker Compose, Installationsskript, tägliches Backup, Update- und Restore-Skript |

## Installation

Voraussetzung: Linux-Server (z. B. Debian 12 als Proxmox-LXC oder -VM) mit Internetzugang.

```bash
git clone <repo-url> portal && cd portal
./install.sh            # fragt Port, Module, Domain, Ablageorte, Paperless und n8n
# oder ohne Rückfragen:
./install.sh --yes
# Paperless-ngx und/oder n8n im selben Stack (auch nachträglich bei bestehender Installation):
./install.sh --paperless --n8n
```

Das Skript installiert bei Bedarf Docker, erzeugt die `.env` mit zufälligem Datenbank-Passwort,
baut und startet alle Container und gibt die Adresse aus. Beim ersten Aufruf im Browser startet der
**Einrichtungsassistent** (Organisation und erster Administrator).

| Container | Aufgabe |
|---|---|
| `app` | Portal (API + Oberfläche), spielt beim Start die Datenbank-Migrationen ein |
| `db` | PostgreSQL 16, Daten in `./data/postgres` |
| `gotenberg` | PDF-Erzeugung |
| `backup` | täglicher `pg_dump` nach `./data/backups`, Rotation nach `BACKUP_KEEP_DAYS` |
| `caddy` | optional (`PORTAL_DOMAIN` gesetzt): HTTPS mit automatischem Zertifikat |
| `paperless`, `paperless-db`, `paperless-redis`, `paperless-tika` | optional (Profil `paperless`): Paperless-ngx mit eigener Datenbank, Port `PAPERLESS_PORT` (8000); die Paperless-Datenbank sichert der `backup`-Container mit (`paperless_<datum>.dump`) |
| `n8n` | optional (Profil `n8n`): n8n für Mailversand und Importe, Port `N8N_PORT` (5678); Workflows in [`docs/n8n`](docs/n8n) |

**Ablageorte** stehen in der `.env` und werden beim Installieren abgefragt, bei `./update.sh` in ältere
`.env`-Dateien ergänzt und als Ordner (Besitzer UID 1000) angelegt:

| Einstellung | Inhalt | Standard |
|---|---|---|
| `SICHERUNG_PFAD` | Portal-Sicherungen (Administration → Sicherung) | `./data/sicherungen` |
| `BACKUP_PFAD` | nächtliche Datenbank-Backups (Archiv, Rotation nach `BACKUP_KEEP_DAYS`) | `./data/backups` |
| `PAPERLESS_PFAD` | Paperless: Datenbank, Dokumente (`media`), Export, Eingang (`consume`) | `./data/paperless` |
| `N8N_PFAD` | n8n: Workflows, Zugangsdaten | `./data/n8n` |

Absolute Pfade (z. B. ein eingebundenes NAS unter `/mnt/nas/portal/…`) sind möglich. Die optionalen Dienste
stehen in `COMPOSE_PROFILES` (z. B. `paperless,n8n`); Passwörter und Schlüssel erzeugt `install.sh` zufällig,
die Paperless-Anmeldung zeigt es am Ende an. Im Portal dann die internen Adressen eintragen:
Paperless `http://paperless:8000` mit API-Token und den Mail-Webhook `http://n8n:5678/webhook/tco-mailversand` mit Webhook-Schlüssel
unter **Administration → Anbindungen** (gilt für alle Module).

Hinter einem vorhandenen Reverse Proxy (z. B. Nginx Proxy Manager): Domain leer lassen,
Proxy auf `http://<server>:<PORTAL_PORT>` zeigen lassen und in der `.env` `SECURE_COOKIES=true` und
`TRUST_PROXY=true` setzen (dann zählt die Client-IP aus `X-Forwarded-For` für die Anmeldesperren).
Ohne Proxy bleibt `TRUST_PROXY=false` – sonst ließen sich die Sperren mit gefälschten Headern umgehen.

Nach der Einrichtung: **TC Oberthal → Stammdaten** ausfüllen (Vereinsname, Anschrift, IBAN, Steuernummer) und
**Administration → Anbindungen** (Paperless, E-Mail-Versand, n8n-Webhooks für EP3, Rückmeldungen und Ferien). Das Repository enthält keine Vereinsdaten; alles kommt aus den Stammdaten bzw. dem SAP-Import.

### Installation über Portainer

1. In Portainer **Stacks → Add stack**, Name z. B. `portal`, **Web editor**.
2. Inhalt von [`portainer-stack.yml`](portainer-stack.yml) einfügen.
3. Unter **Environment variables** `POSTGRES_PASSWORD` mit einem langen Zufallswert setzen
   (optional `PORTAL_PORT`, Standard 8080).
4. **Deploy the stack** – danach `http://<server>:8080` öffnen und den ersten Administrator anlegen.

Ablageorte: Standard sind die Volumes `portal_sicherungen` und `portal_backups`. Mit den Variablen `SICHERUNG_PFAD`
und `BACKUP_PFAD` (absoluter Host-Pfad, Besitzer UID 1000) landen Sicherungen und Backups stattdessen in einem
Ordner auf dem Server. **Mit Paperless-ngx und n8n:** [`portainer-stack-komplett.yml`](portainer-stack-komplett.yml)
verwenden und zusätzlich `PAPERLESS_SECRET_KEY`, `PAPERLESS_DB_PASSWORD`, `PAPERLESS_ADMIN_PASSWORD` und
`N8N_ENCRYPTION_KEY` setzen.

Alle Fachmodule sind aktiv (`PORTAL_MODULES=*`). Was jemand im Menü sieht, steuern die Rollen
(Administration → Rollen): Ein Menüpunkt erscheint nur mit der passenden Berechtigung, eine leere Gruppe
verschwindet ganz. **Update:** Stack öffnen → *Update the stack* mit *Re-pull image* – die Datenbank wird beim
Start automatisch migriert. Daten und Backups liegen in den Volumes `portal_db`, `portal_backups` (nächtlicher pg_dump) und `portal_sicherungen` (Portal-Sicherungen).

### Betrieb

```bash
./update.sh                                   # Backup, git pull, neu bauen, Migrationen
./restore.sh data/backups/portal_<datum>.dump # Backup zurückspielen (ganze Datenbank, Shell)
# Im Portal: Administration → Sicherung – Sicherung je Bereich (Basis, TC Oberthal, Euroflex),
# optional verschlüsselt, Download/Upload, Prüfung und Rücksicherung mit automatischer Sicherheitskopie.
# Format wahlweise .portal (kompakt, optional verschlüsselt) oder ZIP mit XML-Dateien (lesbar, bearbeitbar, importierbar).
# Täglicher Export in die Nextcloud (WebDAV): als eine Datei (.portal/ZIP) oder dateiweise ohne ZIP – je Lauf ein Ordner
# mit einzelnen XML-Dateien, manifest.xml zuletzt, pruefsummen.sha256; nach jeder Übertragung Prüfung der Vollständigkeit.
docker compose exec backup sh /backup.sh now  # Backup sofort
docker compose logs -f app                    # Log ansehen
```

## Entwicklung

```bash
npm install
# Postgres lokal bereitstellen, dann:
DATABASE_URL=postgres://portal:portal@localhost:5432/portal npm run dev:server   # API auf :8080
npm run dev:web                                                                  # Oberfläche auf :5173
TEST_DATABASE_URL=postgres://portal:portal@localhost:5432/portal_test npm test   # Integrationstest
npm run typecheck
```

### Aufbau

```
server/src/          Kern: Anmeldung, Rollen, Änderungsbelege, Einstellungen, PDF, Migrationen
server/migrations/   SQL-Migrationen des Kerns (Schema core)
web/src/             Kern der Oberfläche: Shell, Login, Administration, wiederverwendbare Bausteine
modules/<id>/server  Modul: Routen, Berechtigungen, eigene Migrationen (eigenes DB-Schema)
modules/<id>/web     Modul: Navigation, Seiten, Kacheln
```

## Oberflächen-Leitfaden (Fiori Horizon)

Die Oberfläche folgt den SAP-Fiori-Floorplans; die Gestaltungsschicht liegt in `web/src/styles.css`
(Klassen `portal-*`, ausschließlich Theme-Variablen → Hell/Dunkel und Akzentfarbe automatisch) und den
Kernbausteinen in `web/src/components/`. In Modulseiten **keine eigenen Layouts** mit festen Breiten bauen,
sondern diese Bausteine verwenden:

| Baustein | Zweck (Fiori-Entsprechung) |
|---|---|
| `AppPage` | Seitenrahmen (Dynamic Page): Titel, Untertitel, Aktionen rechts, einklappbarer Kopfbereich, Fußleiste |
| `Filters` / `Filter` / `HeaderKpi` | Filterzeile im Kopfbereich (Filter Bar) mit Beschriftung über dem Feld; Kennzahl rechts |
| `MasterDetail` | Liste links (bleibt beim Scrollen stehen), Objekt rechts; auf dem Handy eine Spalte mit „Zur Liste“ (Flexible Column Layout) |
| `ObjectHeader` | Objektkopf: Avatar/Initialen, Titel, Untertitel, Statuszeile (`ObjectStatus`), Aktionen, Attribute (Object Page Header) |
| `Section` | Abschnitt als weiße Karte mit Titel, Anzahl, Status und Aktionen; `flush` für Tabellen (Object Page Section) |
| `Attributes` / `Attribute` | Beschriftete Anzeigewerte im Raster (Formular-Anzeige) |
| `Tile` | Kachel der Startseite mit optionaler Kennzahl (Launchpad-Kachel); Kennzahl über `HomeTile.kpi` im Modul |
| `FormGrid` / `TextField` / `CheckField` | Eingabeformulare in Dialogen |
| `ConfirmDialog`, `PdfDialog`, `MenuButton`, `ChangeHistoryButton`, `toast` | Sicherheitsabfrage mit Begründung, PDF-Vorschau, Menü-Button, Änderungshistorie, Erfolgsmeldung |

Regeln: Beträge rechtsbündig mit `eur()`, Datum mit `dat()`; Status immer als `ObjectStatus` (Positive/Critical/
Negative/Information), nie als freie Farbe; Diagramme als SVG mit `--sapChart_OrderedColor_1…11`; Texte Deutsch
mit den Fachbegriffen der SAP-App. Hell/Dunkel schaltet der Benutzer im Benutzermenü um (`web/src/theme.ts`).

## Sensible Daten (Feldberechtigungen)

Sensible Felder verlassen den Server ohne passende Berechtigung **nur maskiert** – in Listen, Detailseiten,
PDF-Voransichten, Exporten und Änderungsbelegen. Die Maskierung passiert serverseitig (`server/src/schutz.ts`);
die Oberfläche zeigt nur, was sie bekommt.

| Berechtigung | Wirkung |
|---|---|
| `tco.bankdaten:display` | IBAN, BIC und abweichender Kontoinhaber von Mitgliedern/Zahlern/Lastschriftpositionen im Klartext; Download der SEPA-Datei; Öffnen/Versenden von Paperless-Dokumenten mit Bankdaten (Aufnahmeantrag, Mitgliederinformation, SEPA-Mandat). Ohne: `DE••••••••••••••••3000`, `COBA•••••••`, `E•••• B•••••••` |
| `tco.bankdaten:edit` | Bankverbindung ändern (setzt den Klartext und „Mitglieder pflegen“ voraus) |

Weitere Regeln: maskierte Eingaben werden nie gespeichert (Neuanlage übernimmt eine maskiert vorbelegte IBAN
serverseitig aus Zahler bzw. Aufnahmeantrag); Änderungsbelege bleiben unverändert gespeichert und werden nur bei
der Anzeige maskiert (auch für `core.audit:display`); die eigenen Vereinskonten sind keine Personendaten und
nicht maskiert. Neue geschützte Felder: im Modul `sensitiveFields` (für Änderungsbelege) deklarieren und in den
Routen `feldschutz(req, permission)` anwenden.

## Benutzerverwaltung: Rollenmatrix, Prüfung und Verprobung (Administration)

Die Administration hat den Menüpunkt **Benutzerverwaltung** mit **Benutzer**, **Rollen** (Einzelpflege im Dialog) und
**Rollenmatrix** (`/admin/rollenmatrix`, Berechtigung `core.roles:display`; #46). Die Rollenmatrix hat drei Ansichten:

- **Matrix:** Zeilen = Berechtigungen (Modul › Bereich › App), Spalten = Rollen (ohne `ADMIN`). Kästchen setzen und entfernen Rechte;
  Voraussetzungen werden wie im Dialog mitgesetzt bzw. abhängige Rechte mit entfernt. Filter: Suche, Rollenauswahl, „nur vergebene“,
  „nur Unterschiede“. Änderungen mehrerer Rollen werden gesammelt (gelb markiert) und mit **Sichern** in einer Transaktion geschrieben
  (`PUT /api/admin/roles/matrix`, `core.roles:edit`). Der Server lehnt ab, wenn eine Rolle inzwischen geändert wurde (409), bei
  unbekannten Kennungen, Systemrollen und – wie in der Einzelpflege – bei „nur Admin“-Rollen ohne Administrator bzw. mit `core.*`-Rechten.
- **Prüfung** (`POST /api/admin/roles/pruefung`, `core.roles:display`; läuft auch auf dem ungesicherten Stand der Matrix):
  Rollen deckungsgleich (Fehler), Rolle vollständig in einer anderen enthalten (Warnung), Überlappung ab 60 % gemeinsamer Rechte
  (Hinweis), Benutzer mit überflüssiger Rolle (Warnung), Funktionstrennung in einer Rolle oder bei einem Benutzer über mehrere Rollen
  (Warnung; Paare aus `rechteKonflikte` der Module und `coreKonflikte`), fehlende Voraussetzung und unbekannte Kennung (Fehler),
  Rolle leer / ohne Benutzer und Rechte in keiner Rolle (Hinweis). „Vergleichen“ stellt die betroffenen Rollen in der Matrix
  nebeneinander und hebt die betroffenen Rechte hervor. Befunde verhindern das Sichern nicht.
- **Verprobung** (`POST /api/admin/roles/verprobung`, `core.roles:display` und `core.users:display`; liest nur): für einen oder mehrere
  Benutzer (auch „alle Benutzer der Rolle …“, höchstens 200) die wirksamen Rechte mit dem Stand der Matrix einschließlich ungesicherter
  Änderungen – optional mit probeweise zugeordneten Rollen (zusätzlich oder statt der bisherigen). Je Benutzer: Rollen heute und in der
  Probe, Anzahl Rechte und Apps, was dazukommt und wegfällt, Herkunft jedes Rechts (Rolle), Befunde (Funktionstrennung, überflüssige
  Rolle, deaktivierte Rolle, gesperrter Benutzer). „Matrix“ stellt die Rollen der Probe nebeneinander.
- Logik: `server/src/rollenpruefung.ts` (reine Funktionen), Oberfläche `web/src/pages/RollenmatrixPage.tsx` und `RollenMatrix.tsx`,
  Test `server/test/rollenmatrix.test.ts`.

## Tabellenansicht (Administration)

Administration → **Tabellenansicht** (Berechtigung `core.tabellen:display`) zeigt alle Tabellen und Sichten der
Schemas `core` und der aktiven Module – wie SE16; Löschen nur mit eigener Berechtigung und Papierkorb (siehe unten).

- **Übersicht**: Schema, Tabelle, Art, Beschreibung (Tabellenkommentar), Zeilen (geschätzt), Spalten, Größe – suchbar,
  filter-, sortier- und gruppierbar; Klick oder Auswahlfeld oben öffnet die Tabelle.
- **Struktur**: Spalte, Datentyp, Primärschlüssel (Position), Pflichtfeld, Vorschlagswert, Schutz, Spaltenkommentar.
- **Selektion** (serverseitig, Auswahl je Tabelle für die Sitzung gemerkt; Ausführen auch mit F8/Strg+Enter):
  - Bedingungen je Spalte, UND-verknüpft: `=`, `≠`, `<`, `≤`, `>`, `≥`, von–bis, enthält/Muster (`*` beliebig, `+` ein
    Zeichen, ohne Platzhalter „enthält“, Groß-/Kleinschreibung egal), enthält nicht, Liste (`;`-getrennt), leer, nicht leer.
    Datum als `JJJJ-MM-TT`, Dezimalzahlen mit Punkt; ungültige Eingaben ergeben eine verständliche Meldung.
  - Feldauswahl, bis zu 5 Sortierfelder (ohne Angabe: Primärschlüssel), max. Trefferzahl 100/500/1.000/5.000 mit „Weitere laden“.
  - **Gruppierung** nach bis zu 5 Feldern mit Anzahl und Kennzahlen je Gruppe (Summe, Durchschnitt, Minimum, Maximum,
    Anzahl verschiedene; Summe/Durchschnitt nur über Zahlenfelder).
- **Ergebnis**: zusätzlich Spaltenfilter, Sortierung und Gruppierung in der Tabelle, Klick auf eine Zeile zeigt alle
  Felder untereinander, Export als CSV (Excel, Semikolon, UTF-8).

**Schutz**: Spalten mit Kennwort-Hashes, Tokens, Zugangsschlüsseln und Passwörtern (`*hash*`, `*token*`, `passw*`,
`kennw*`, `*secret*`, `*_auth`, `n8n_*_key`, `core.sperren.sitzung`) kommen immer als `•••` – auch Filter, Sortierung
und Gruppierung arbeiten auf dem maskierten Wert, damit nichts erraten werden kann. Felder aus `sensitiveFields`
(Bankdaten) sind ohne die jeweilige Berechtigung maskiert wie im Rest des Portals, auch in `core.change_item`.
Jede Abfrage läuft in einer lesenden Transaktion mit 20 Sekunden Zeitlimit; Zellen werden nach 2.000 Zeichen gekürzt,
`bytea` erscheint als `[n Bytes]`. Tabellen- und Spaltennamen werden gegen den Systemkatalog geprüft.

**Löschen mit Papierkorb** (Berechtigung `core.tabellen:delete`, #34): Im Ergebnis (ungruppiert) lassen sich Zeilen markieren und
mit „Löschen“ samt Begründung entfernen. Jeder gelöschte Satz wird vorher vollständig in `core.tabellen_papierkorb` gesichert
(Migration `012_tabellen_papierkorb.sql`) und ist **7 Tage** über **Papierkorb** (oben rechts) wiederherstellbar – genau so, wie er
gelöscht wurde; danach entfernt das Portal die Einträge automatisch. Grenzen: nur echte Tabellen mit Primärschlüssel (keine Sichten,
kein Schlüssel mit Geheimnis wie `core.sessions`), nicht `core.change_header`/`core.change_item` und der Papierkorb selbst,
höchstens 1.000 Sätze je Vorgang. Sätze mit abhängigen Einträgen, die per `ON DELETE CASCADE/SET NULL` still mitgeändert würden,
werden **nicht** gelöscht – die Meldung nennt die Tabellen. Löschen und Wiederherstellen erzeugen Änderungsbelege
(`TABELLE_LOESCHEN`, `TABELLE_WIEDERHERSTELLEN`). Die gesicherte Zeile ist in der Tabellenansicht maskiert. Endpunkte:
`POST /api/admin/tabellen/:schema/:tabelle/loeschen`, `GET /api/admin/tabellen/papierkorb`,
`POST /api/admin/tabellen/papierkorb/wiederherstellen`, `POST /api/admin/tabellen/papierkorb/entfernen`.

## Neues Modul anlegen (z. B. `transport`)

Vorlage ist `modules/beispiel` (Kontakte mit Liste, Objektseite, Löschen mit Begründung, PDF, Historie).

1. Ordner kopieren: `cp -r modules/beispiel modules/transport` und Inhalte umbenennen.
2. **Datenbank** – `modules/transport/server/migrations/001_*.sql`:
   ```sql
   create schema transport;
   create table transport.auftraege ( ... );
   select core.enable_audit('transport.auftraege', 'AUFTRAG', 'auftragsnr', '', 'id,created_at,updated_at');
   ```
3. **Server** – `modules/transport/server/index.ts`: `id: 'transport'`, Berechtigungen
   (`transport.auftraege:display|edit|storno`), `auditObjects`, Routen.
   Schreibende Zugriffe immer über `change(req, tx => ...)` – dann kennt der Änderungsbeleg Benutzer,
   Aktion und Begründung. Prüfung im Backend mit `requireAuth('<berechtigung>')` bzw. `can(req, ...)`.
4. **Oberfläche** – `modules/transport/web/index.ts`: Navigation, Routen, Kacheln.
   Bausteine: `AppPage`, `FormGrid`/`TextField`, `ChangeHistoryButton`, `ConfirmDialog` (mit Begründung), `api`, `toast`.
5. Registrieren in `server/src/modules.ts` und `web/src/modules.ts`.
6. Aktivieren in der `.env`: `PORTAL_MODULES=transport` und `./update.sh`.

## Modul `transport` (Euroflex-Auftragsverwaltung)

Portierung der abap2UI5-App `Z2UI5_CL_EU_AUFTRAG` mit der Logik aus `ZCL_EU_AUFTRAG`.
Einschalten mit `PORTAL_MODULES=transport` in der `.env`. Gotenberg wird dafür **nicht** gebraucht:
Rechnung, Lieferschein und Transportauftrag werden per Code (PDFKit) erzeugt.

| Funktion | Inhalt |
|---|---|
| Aufträge | Fracht- und Holzträgeraufträge, Liste (gruppiert nach Status) oder Baum Art → Kunde → Auftrag mit Saldo, Filter Geschäftsjahr/Fakturadatum/Status/Suche |
| Objektseite | Beteiligte (Kunde, Unternehmer, abw. Rechnungsempfänger – Auswahl zeigt höchstens 50 Treffer, beim Tippen wird über alle Kontakte gesucht, jedes Wort in Name oder Ort), Auftrags-/Fahrzeugdaten mit Rechnung (Gewicht in T, Lademeter in M; „Drucken → Rechnung“ öffnet dieselbe E-Rechnungs-Vorschau wie „Versenden → E-Rechnung“ in der Liste), zwei Stops, Holzträgerpositionen, Dokumente, Besonderheiten, Änderungshistorie |
| Rechnungen | Einzel- und Sammelrechnungen mit lückenlosen Nummern (Start je Jahr in den Stammdaten), PDF mit EPC-GiroCode, XRechnung 3.0 (UBL) |
| Versand | E-Mail-Texte D/E mit Platzhaltern, Rechnung an Paperless-ngx (Zugang unter Administration → Anbindungen) |
| Stammdaten | Firmendaten inkl. Logo, Produkte, Wertelisten (Fahrzeugtyp, Ladegut, Ladeweise, Palettentausch – je Liste „Einfügen“: mehrere Werte per Copy & Paste, eine Zeile je Wert, optional `Schlüssel;Text` oder zwei Excel-Spalten; vorhandene werden übersprungen, `POST /werte/masse`), E-Mail-Texte, Datenimport |
| Übernahme aus SAP | *Stammdaten → Datenimport* (`/transport/stammdaten?tab=IMPORT`, Recht `transport.import:execute`): CSV-Exporte (Aufträge, Aufträge_POs, Adressen, optional Träger, Produkte, Wertelisten, ZEU_RGNRKREIS). Standard: nur neue Sätze werden angelegt, Nummernkreise werden nachgezogen. **Neuaufbau** (#121): Tabellen vorher leeren und komplett neu anlegen – siehe unten |

Berechtigungen: `transport.auftraege:display|edit`, `transport.rechnungen:create`, `transport.versand:execute`,
`transport.kontakte:edit`, `transport.stammdaten:edit`, `transport.import:execute`.

### Übernahme aus SAP: Import und Neuaufbau (#121)

Reiter *Euroflex → Stammdaten → Datenimport* (direkt: `/transport/stammdaten?tab=IMPORT`). Alle CSV-Dateien des SAP-Exports auf einmal ablegen;
jede Datei wird am **Spaltenkopf** erkannt (Dateiname egal, Kodierung UTF-8 oder Windows-1252, Semikolon).

| SAP-Datei | Ziel im Portal | Neuaufbau |
|---|---|---|
| `Aufträge.csv` (ZEU_AUFTRAG) | `transport.auftraege` | Pflicht, wird geleert |
| `Aufträge_POs.csv` (ZEU_AUFTAG_POS) | `transport.stops` | Pflicht, wird geleert |
| `Adressen.csv` (ZEU_ADRESSEN) | `transport.adressen` | Pflicht, wird geleert |
| `ZEU_TRAEGER.csv` | `transport.traeger` | Pflicht, wird geleert |
| `ZEU_PRODUKTE.csv` | `transport.produkte` | optional, wird nur geleert, wenn die Datei dabei ist |
| Wertelisten (DD07T der Domänen ZEU_LADEART/-GUT/-WEISE/ZEU_PALETTENTAUSCH) | `transport.werte` | optional, wird nur geleert, wenn die Datei dabei ist |
| `ZEU_RGNRKREIS.csv` (GJAHR, TYP, NUMMER) | `core.number_ranges` (`TRANSPORT_AUFTRAG` = Typ A, `TRANSPORT_RECHNUNG` = Typ R; andere Typen werden ignoriert) | Nummernkreise werden **genau** auf den SAP-Stand gesetzt (mindestens die höchste importierte Nummer) |
| `ZEU_DOSSIER`, `ZEU_LADEGUT_T`, `ZGN_ALV_FIELDS`, `ZGN_CUST` | – | werden erkannt und als „nicht benötigt“ übersprungen (Altbestand, ALV-Spaltentexte, SAP-GUI-Druckpfade; Ladegut kommt aus der Werteliste) |

- **Import (Standard):** Nur neue Schlüssel werden angelegt, vorhandene Sätze bleiben unverändert (leere Adressen
  werden ergänzt), Nummernkreise werden nur hochgezogen.
- **Neuaufbau** (Kästchen im Reiter, Sicherheitsabfrage mit Pflicht-Begründung): In **einer** Transaktion werden die
  Tabellen per `TRUNCATE` geleert und komplett aus den Dateien angelegt. Schlägt etwas fehl, bleibt alles wie vorher.
  Die Prüfung zeigt vorher, wie viele Sätze gelöscht werden und wie viele im Portal erfasste Aufträge **nicht** in der
  Datei stehen (sie gehen verloren). Verknüpfungen Auftrag ↔ Paperless-Dokument bleiben für Aufträge erhalten, die in
  der Datei wieder vorkommen; die Dokumente selbst bleiben in Paperless. Änderungsbeleg mit Aktion `IMPORT_NEUAUFBAU`.
  Vorher eine Sicherung ziehen (*Administration → Sicherung*, Bereich Euroflex).
- API: `POST /api/m/transport/import/pruefen` bzw. `/import/ausfuehren` mit
  `{ dateien: [{ name, data (Base64) }], modus: 'neu' | 'ersetzen', reason }` (Recht `transport.import:execute`, bis 20 Dateien).

### Ablageordner auf dem PC (#121)

Ausdrucke und Dateien können zusätzlich in einem **Ordner auf dem PC** abgelegt und von dort geöffnet werden
(z. B. im OneDrive-Ordner „Aufträge und Co“). Einrichten: *Stammdaten → Firmendaten → Ablageordner auf diesem PC → Ordner wählen*.

- Aufbau: `<Ordner>\<Jahr>\<Auftragsnummer>\` – der Auftragsordner wird bei der **Anlage** des Auftrags erzeugt.
- **Drucken** (Transportauftrag, Lieferschein, Rechnung – auf der Auftragsseite und in der Liste, auch direkt nach
  Einzel-/Sammelrechnung) speichert das PDF in den Auftragsordner und zeigt die gespeicherte Datei in der Vorschau;
  eine Sammelrechnung landet in jedem beteiligten Auftragsordner. Gleichnamige Dateien werden überschrieben.
- **Drag & Drop / Strg+V** im Abschnitt *Dokumente* des Auftrags legt die Dateien im Auftragsordner ab (und wie bisher
  in Paperless, wenn eingerichtet). Darunter listet *Ablageordner* alle Dateien des Ordners; ein Klick öffnet sie aus dem Ordner.
- **E-Mail mit Anhängen…** (Abschnitt *Dokumente*, Recht `transport.versand:execute`): Vorlage Transportauftrag / Lieferschein /
  Rechnung (Texte aus *Stammdaten → E-Mail-Texte*, Empfänger wie beim Versenden aus der Liste) oder freier Text – Empfänger,
  Betreff und Nachricht anpassbar; Anhänge aus dem Ablageordner und aus Paperless per Häkchen wählen (passende Dateien sind
  vorausgewählt). *Entwurf öffnen* erzeugt eine E-Mail-Datei (`.eml`, Kopf `X-Unsent: 1`) mit den Anhängen, die sich im
  Standard-Mailprogramm als neuer Entwurf öffnet (Outlook mit „Senden“; sonst in den Downloads anklicken – in Chrome/Edge
  „Dateien dieses Typs immer öffnen“). *Ohne Anhänge* öffnet direkt per `mailto:` (Browser können über `mailto:` keine Anhänge übergeben).
  Direkt öffnen: Eine Webseite darf keine Programme starten – nach dem ersten Download erklärt der Dialog die einmalige Einstellung
  „Dateien dieses Typs immer öffnen“ (Strg+J → ⋯ beim .eml-Eintrag); danach öffnet sich jeder Entwurf sofort. Zusätzlich übergibt
  *Teilen…* (Chrome/Edge unter Windows, Web Share API) Text und Anhänge über die Windows-Freigabe direkt an Outlook bzw. Mail;
  der Empfänger liegt dann in der Zwischenablage.
- Technik: File System Access API – nur **Microsoft Edge / Google Chrome**. Der Ordner wird je PC und Browser gemerkt
  (IndexedDB, nichts auf dem Server). Nach einem Browser-Neustart fragt der Browser beim ersten Druck einmal nach dem Zugriff.
  Ist kein Ordner gewählt oder der Zugriff verweigert, läuft alles wie bisher (nur Vorschau/Download).

### Regeln für Buchhaltungs-/Belegobjekte

- **Ohne MwSt** (#121, Migration `006_steuerbefreiung.sql`): Ist *MwSt berechnen* aus, wählt man den Grund –
  *Übergang der Steuerschuld auf den Leistungsempfänger (Reverse Charge)* oder *Umsatzsteuerfreier Transport in ein Drittland
  gem. § 4 Nr. 3 Buchst. a Unterbuchstabe aa UStG* (Feld `steuerbefreiung` = `RC` | `DRITTLAND`). Der Text steht wie bisher
  unter dem Rechnungsbetrag (bei gemischten Sammelrechnungen je Grund eine Zeile) und als Befreiungsgrund in XRechnung/ZUGFeRD
  (Kategorie AE bzw. E). Altaufträge ohne Wahl werden wie bisher aus dem Land des Rechnungsempfängers abgeleitet; mit MwSt wird
  der Grund verworfen. Der Grund bleibt auch **nach der Faktura korrigierbar** (ändert nur Text/Steuerkategorie, nicht die
  Beträge); Rechnung und E-Rechnung werden beim nächsten Druck/Abruf mit dem neuen Text erzeugt.

- **Fakturierte Aufträge** (#121) sind gesperrt: Die Objektseite zeigt alle Felder schreibgeschützt, der Server
  übernimmt bei `PUT /auftraege/:nr` nur noch **Dokumente fehlen** (Schalter Ja/Nein) und die **Besonderheiten**.
  Dokumente können weiterhin zugeordnet und gelöst werden.

- Gebuchte Belege nie ändern: **Storno = Gegenbeleg** mit Verweis auf den Originalbeleg, Aktion `STORNO`
  und Pflicht-Begründung (`change(req, fn, { action: 'STORNO', reason })`).
- Belegnummern über `core.next_number('<id>', <jahr>)` – die Nummer wird nur verbraucht, wenn die
  Transaktion erfolgreich ist (lückenlos).
- Vier-Augen-Prinzip später: getrennte Berechtigungen (z. B. `:erzeugen` / `:freigeben`) anlegen und
  über Rollen trennen – kein Umbau nötig.

## Modul `tco` (TC Oberthal – Vereinsportal)

System- und Prozesslandschaft in vier Ebenen (Systeme, Prozesse, Prozessschritte, Datenbank): [docs/landschaft](docs/landschaft/README.md) –
wird mit `npm run doku:landschaft` aus dem Code erzeugt und nach jedem Push auf `main` automatisch aktualisiert (#118).

Portierung der abap2UI5-Apps des Vereinsportals. Einschalten mit `PORTAL_MODULES=tco`.
Das Datenmodell (Schema `tco`) enthält alle Vereinstabellen aus SAP; alle Apps der SAP-Navigation (`Z2UI5_TCO_MAINPAGE_V2`) sind übernommen.

| App | Stand |
|---|---|
| Hallenabrechnung | fertig: EP3-Import (n8n-Workflow `docs/n8n/tco-ep3-import.json` oder CSV), Preisfindung je Buchungsminute, Zuordnen einzeln/gesammelt/automatisch, manuelle Positionen inkl. Schlüsselliste (Text, Menge, Einzelpreis und Konto nachträglich änderbar, solange die Rechnung änderbar ist – auch bei Gutschriften; `PUT /halle/rechnungen/:rgnr/positionen/:pos`), Kontierung je Position als eigene Spalte (Erlöskonto der Position, sonst des Produkts, sonst Hallenmiete), Rechnungs-PDF mit GiroCode, Ablage in Paperless (Neudruck = neue Version, Freigabelink, Metadaten; alle Fassungen im Portal abrufbar – Fassungen eines Neudrucks über `GET /halle/paperless/:id/pdf?root=<Stammdokument>`, geprüft gegen das Dokument der Rechnung), Versand per E-Mail (n8n-Workflow „TCO Mailversand“, Absender = Bearbeiter), **Sammelversand** (alle Rechnungen „In Bearbeitung“ als Vorschlag, Auswahl über Wertgrenze, Anzeige der gepflegten E-Mail-Adresse je Empfänger, nach Freigabe Druck und Versand ausschließlich per E-Mail – je Empfänger eine E-Mail, Betreff und Text der E-Mail bei der Freigabe sichtbar und änderbar mit den Platzhaltern `{Vorname}` und `{Rechnungsnummer}` und Vorschau, Ergebnis als Protokolltabelle; `GET/POST /halle/sammelversand`, `GET /halle/sammelversand/mailtext`, Berechtigung `tco.halle:versand`), Zahlung mit **Splitbuchung nach Erlöskonten** der Produkte, WhatsApp und Mailentwurf, Wiedereröffnen versendeter Rechnungen mit Begründung, Hallenpreise mit Prüfung – Pflege als **Wochenplan** (sieben Wochentage nebeneinander je Preisgruppe Einzel Winter/Sommer bzw. Abo und Zeitraum: Preis wählen und als Block in den Plan ziehen, Blöcke verlängern/verschieben/auf andere Tage übernehmen, neuer Zeitraum kopiert den Vorgänger) oder in Tabellen |
| FI Belege | fertig: Buchungsliste je Zeitraum/Konto mit Jahresanfang, Tagessaldo und aktuellem Saldo, Bankimport (CSV-Umsatzexport) mit Abgleich, Gegenkonto- und Belegvorschlag, Aufteilung (z. B. SumUp-Gebühren), manuelle Buchung für Kasse/Konten ohne Bankdatei, Hallenrechnung zuordnen (Teilzahlung), Belege aus Paperless zuordnen/entfernen, Beleg einer früheren Zahlung übernehmen, Notizen, **Storno per Gegenbuchung** – FI-Belege sind in der Datenbank gegen Ändern und Löschen gesperrt |
| Sollstellung | fertig: Gläubigerdaten mit Prüfung (IBAN, Gläubiger-ID), Vorschlag je Sollmonat (Turnus, Laufzeit, Beitragsstamm, Zahler am Vertrag bzw. abweichender Zahler, Mandat, Ausschlussgründe), einzelne Positionen abwählbar, SEPA-Datei pain.008.001.02 im Linear-Layout (je Zahler und Mandat eine Lastschrift), PDF-Protokoll mit Ablage in Paperless, Storno. **Verbucht wird nur in FI Belege:** der Bankimport erkennt die Sammelgutschrift und bucht sie je Position auf die Erlöskonten; ein Storno dort öffnet den Lauf wieder |
| Jugendtraining | fertig: Trainingszeiten erfassen/importieren (n8n, Nextcloud), Zeitnachweise als PDF mit Ablage in Paperless, Trainer und Trainerentgelte, als bezahlt kennzeichnen |
| Clubhausabrechnung | fertig: Getränkerechnungen, Belegzuordnung, Forderungsliste berechnen und ablegen, Getränkepreise, Absatz und Diagramme |
| Mitglieder | fertig: Stammdaten, Bank & SEPA-Mandat, Verträge, Familie & Schlüssel, Dokumente (Paperless), Notizen, Unterlagen (Aufnahmeantrag, Mitgliederinformation) drucken/ablegen/versenden, Neuanlage mit Vertrag. **Vertragsbaum** (Reiter „Verträge“ und „Meine Mitgliedschaft“, Layout wie die Gruppenpflege; Komponente `VertragsBaum`): alle verknüpften Personen (Mitglied, abweichender Zahler, Familie) mit ihren Verträgen – Zahler oben, darunter wer über ihn zahlt (`zahlt_ueber` je Person in `familie`), dann die Verträge; Suche, „Auch beendete“, Auf-/Zuklappen, Spalten Turnus, Beginn, Ende, Betrag (je Person Summe der laufenden Verträge „· davon eigene“), Zahler, Status, Aktionen. Ende und Zahler sind änderbar für Verträge des Mitglieds und der Personen, die über es zahlen; Vertrag je Person hinzufügen, andere Personen per Klick öffnen. In „Meine Mitgliedschaft“ kündbar: eigene Verträge und die von Personen, die über das Mitglied zahlen (`vertraegeFamilie[].kuendbar`) |
| Mitgliedergruppen | fertig: Mitglieder nach Kategorien gruppieren (z. B. Spielbetrieb → Mannschaftsspieler → Herren 40, reine Hallennutzer, ohne Teilnahme am Spielbetrieb) – Gruppen als beliebig tiefer Baum, ein Mitglied in mehreren parallelen Gruppen, Rolle je Zuordnung (z. B. Mannschaftsführer). **Hierarchieregel:** Wer in einer Untergruppe ist, gehört zwingend auch zu den Gruppen darüber und wird dort nicht noch einmal aufgenommen – je Linie steht ein Mitglied nur in der untersten Gruppe (Aufnahme in eine Untergruppe oder Verschieben einer Gruppe entfernt die Zuordnung darüber). Pflege in der eigenen App im Baum (anlegen, umbenennen, verschieben – auch per Ziehen und Ablegen für Gruppen und Mitglieder –, löschen, aktive Mitglieder gesammelt aufnehmen – mit Filter nach Geschlecht, Alter und Jahrgang, z. B. männlich ab 40 Jahre –, Suche) und im Mitgliedsstamm (Reiter „Gruppen“); Filter „Gruppe“ in der Mitgliederliste (einschließlich Untergruppen). In „Meine Mitgliedschaft“ sieht jedes Mitglied seine Gruppen und trägt sich selbst ein oder aus (Rollen vergibt der Verein). Der Vereinskalender filtert für Organisatoren, die selbst Mitglied sind, standardmäßig auf „Nur meine Gruppen“ (abschaltbar). Es sind dieselben Gruppen wie im Vereinskalender: Eine Veranstaltung für eine Gruppe gilt auch für die Mitglieder ihrer Untergruppen. Berechtigungen `tco.gruppen:display` / `tco.gruppen:edit`, Zuordnung im Mitgliedsstamm mit `tco.mitglieder:edit` **Position:** Jede Gruppe hat eine Position innerhalb ihrer Ebene (kleinste zuerst, ohne Position danach nach Name; Migration `043_gruppen_position.sql`). **Regelwerk** (gesamt über die Schaltfläche „Regelwerk“, je Gruppe über das Symbol in der Zeile – die Gruppe zeigt ihre Regel im Baum; `tco.gruppen:edit`). **Neu berechnen** wendet das Regelwerk auf den gesamten Baum oder auf einen Knoten (Gruppe mit Untergruppen) an und zeigt das Ergebnis als Tabelle (`POST /gruppen/regeln/anwenden` mit `gruppe_id`; `PUT /gruppen/regeln` mit `gruppe_id` ersetzt nur das Regelwerk dieser Gruppe). Regeln: Regeln ordnen aktive Mitglieder nach Alter und Geschlecht einer Gruppe zu (z. B. Kleinfeld 6–7, Midfeld 8–10 Jahre). Geschlecht je Regel: alle (gemischte Mannschaften), männlich oder weiblich (Migration `042_gruppen_regeln_geschlecht.sql`). Kennzeichen „Kalenderjahr zählt“: das ganze Jahr zählt, in dem das Alter erreicht wird oder noch erreicht war; sonst gilt das Alter am Tag der Ausführung. Beim Anwenden werden passende Mitglieder aufgenommen, Zuordnungen aus dem Regelwerk, die nicht mehr passen, entfallen; „Andere entfernen“ nimmt auch von Hand Zugeordnete heraus. Vorschau ohne Änderung, Ergebnis als Tabelle. Für einen Job (z. B. n8n, täglich): `POST /api/m/tco/gruppen/regeln/anwenden` mit API-Schlüssel (`{"simulation": true}` = nur Vorschau); `GET/PUT /gruppen/regeln`, Migration `041_gruppen_regeln.sql` Baum: Hat eine Gruppe Untergruppen, stehen ihre direkt zugeordneten Mitglieder in einem eigenen Knoten „Direkt in … (ohne Untergruppe)“ vor den Untergruppen |
| Vereinskalender | fertig: Veranstaltungen ankündigen, An- und Abmeldung, Gruppen/Mannschaftsplanung, Liste und Monatsansicht (Farbmuster je Art im Monatsraster mit Legende: Mannschaft / Spieltag grau mit weißer Schrift, Veranstaltung gelb mit fetter schwarzer Schrift und schwarzem Rand, Training grün, Turnier blau, Arbeitseinsatz orange, Sitzung violett; ein Punkt zeigt die eigene Rückmeldung), Filter, Kopierfunktion. **Massenanlage** („Mehrere anlegen“): Spielplan als Text einfügen (Tabulator, „\|“ oder Tabelle aus der Zwischenablage; Hinweis im Dialog: „Prompt in Claude nach Screenshot bei STB.LIGA.NU => Teile mir diesen Screenshot in Spalten auf“), im Dialog eingebettete, aufklappbare Anleitung in sechs Schritten mit Bildern (`modules/tco/web/kalender/anleitung/`), Aufbereitung als Tabelle mit Filtern (Suche, Liga, nur künftige) und Massenbearbeitung (Titel, Ort, Art, Gruppe, Dauer, Anmeldung), danach Freigabe und Anlegen mit Protokolltabelle. Zuordnung: Titel = Präfix + Liga, Art = Mannschaft / Spieltag, Ort = Halle \| Platz, Beginn = Datum und Uhrzeit, Beschreibung = Heim – Gast und Spiel-Nr., Gruppe = passende Mitgliedergruppe zur Liga. Gleiche Veranstaltungen (Titel und Beginn) werden nicht doppelt angelegt. `POST /kalender/masse/vorschau`, `POST /kalender/masse`, Textlogik in `modules/tco/server/kalender/spielplan.ts`; Berechtigung `tco.kalender:edit`. Veranstaltungen für Gruppen: Rückmeldungen gibt es nur für Mitglieder dieser Gruppen (und ihrer Untergruppen) – Mitglieder melden nur sich selbst, Organisatoren tragen nur für Mitglieder der Gruppen ein; andere Personen sind in der Auswahl ausgeblendet (`GET /kalender/pflege/mitglieder?event=<id>`). **Tabelle** (Reiter „Tabelle“, `tco.kalender:edit`): alle Veranstaltungen flach, Suchfeld über alle Textspalten (jedes Wort muss vorkommen), Filter und Sortierung je Spalte, Mehrfachauswahl, Massenbearbeitung (Titel, Ort, Art, Gruppe, Anmeldung; `POST /kalender/masse/aendern`), Massenlöschung der Auswahl mit Sicherheitsabfrage („Auswahl löschen“; `POST /kalender/masse/loeschen`) und Regelwerk „Text in Spalte => Gruppe“ (Spalte Titel, Beschreibung oder Ort enthält Text → Standardzuordnung zu einer Gruppe; erste passende Regel gilt; `GET/PUT /kalender/regeln`, `POST /kalender/regeln/anwenden` mit `ids`, `ueberschreiben`, `simulation`; Migration `044_kal_event_regeln.sql`). Das Regelwerk schlägt auch bei „Mehrere anlegen“ die Gruppe vor. Monatsraster: Einträge größer, bis zu zwei Zeilen. **Gruppen / Mannschaften** (Reiter, `tco.kalender:edit`): derselbe Baum im Layout der App „Mitgliedergruppen“ (Komponente `GruppenBaum`, eingebettet) – Suche, „Mitglieder anzeigen“, Auf-/Zuklappen, Spalten Gruppe/Mitglied, Rolle, Mitglieder, Aktionen (Mitglieder aufnehmen mit Filtern, Untergruppe anlegen, ändern/verschieben, löschen, Ziehen und Ablegen). `tco.kalender:edit` darf dafür die Pflege-Endpunkte `/gruppen` nutzen; Regelwerk und Neu berechnen bleiben `tco.gruppen:edit` vorbehalten (`GET /gruppen` liefert `regelwerk`). **Einfache Ansicht** (nur `tco.kalender:anmelden`, ohne Pflegerecht): keine Reiterleiste, Zeitraum-Navigation und Filter eingeklappt, Liste der nächsten 12 Monate ab heute; „Ansicht & Filter“ blendet sie ein, „Einklappen“ kehrt zurück. **Weitere Personen:** Bei Veranstaltung und Arbeitseinsatz kann jedes Mitglied angeben, wie viele weitere Personen es mitbringt (in der Liste neben „Dabei“ und im Detail; bei den übrigen Arten nur mit Schalter „Weitere Personen anmeldbar“). Sie zählen in der Teilnehmerzahl und gegen die Höchstzahl mit (`begleitung_moeglich` je Veranstaltung) |
| Vereinsübersicht | fertig: Dashboard auf der Startseite mit KPI-Kacheln/Cards je Bereich (Mitglieder, Clubhaus, Finanzen, Jugend, Halle), Geschäftsjahr, Diagramme (Mitgliederentwicklung, Clubheimerträge, Einnahmen/Ausgaben/Kontostand mit Jahres-/Kontenauswahl, Trainingsstunden je Trainer, Hallenbuchungen Abo/Einzel), Liquidität, Detail-Popups, Beitragsstufenwechsel Jugendliche → Erwachsene mit Bestätigung und Änderungsbeleg **Belegungsquote Halle:** Zeitraum in der Kachel wählbar – laufender Monat, Saison (01.09.–30.04.) oder Kalenderjahr, jeweils bis heute (`GET /dashboard?halZeitraum=MONAT|SAISON|JAHR`). Kapazität = Buchungszeiten der aktiven Hallenplätze („gültig ab“ zählt nicht, nur „gültig bis“); Buchungen ohne Platz (aus SAP übernommen) zählen innerhalb der Buchungszeiten der Halle mit, Buchungen auf Freiplätzen nicht **Offene Hallenstunden** (Kachel mit Detail, `GET /dashboard/detail/HAL_ABR`): gebucht, aber noch nicht bezahlt – vergangene und künftige Buchungen ohne Rechnung (Preis je Termin aus den Hallenpreisen; Abos mit allen offenen Terminen in den Stunden und dem Abo-Preis im Betrag) sowie nicht bezahlte Rechnungen (Status in Bearbeitung, gedruckt, versendet, teilbezahlt) mit den Stunden ihrer Buchungspositionen und dem offenen Betrag abzüglich Teilzahlungen; ohne Stornos, Ausschlussliste der Stammdaten, Jugendtraining, Hallensäuberung und Sperrungen |
| Mitglieder-Analyse, Teilnehmer Jugendtraining, Dokumenten-Upload | fertig: Grid-Tabelle mit serverseitiger Gruppierung/Zwischensummen, 14 Filter, Sortierung, Spaltenauswahl, Anzeigevarianten (eigene/globale), Kennzahlen, SVG-Diagramme, CSV-Export; Teilnehmerliste Jugendtraining mit Filter Alle/Mitglieder/Nichtmitglieder, Suche, Mehrfachauswahl und „E-Mail an Auswahl“ (BCC), Detail mit Verträgen; Mehrfach-Upload von Belegen nach Paperless mit Dokumenttyp, Korrespondent, Datum, Tags, Speicherpfad, Notiz und Statusliste |
| Beiträge | fertig: Beitragsstamm mit zeitabhängigen Beträgen (lückenlos, letzter Zeitraum offen), neuer Betrag ab Datum teilt den Zeitraum, Löschen verlängert den Vorgänger, Prüfungen (Pflichtfelder, Erlöskonto im Kontenstamm, Lücken/Überschneidungen), aktiv/inaktiv, Hinweis auf bestehende Sollstellungspositionen, Erstbefüllung aus den Verträgen, Verträge je Beitragsart |
| Beitragsforecast | fertig: Hochrechnung Basisjahr/Folgejahr je Monat und Vertragsart aus den laufenden Verträgen (Stichtag Monatserster, Januar alle, Juli ohne Spende, übrige Monate Jugendtraining), Vorjahr als Vergleich, Säulendiagramm, Mitglieder als dritte Stufe |
| Einnahmen & Ausgaben | fertig: Kennzahlen Einnahmen/Ausgaben/Gewinn/Geldbestand, Abgleich mit der Veränderung der Geldbestände, Säulendiagramm je Monat, Monats- und 5-Jahres-Tabelle, Geldkonten mit Anfangsbestand/Zugang/Abgang, Einnahmen und Ausgaben je Konto mit Vorjahr, Liquidität, Monatsverlauf je Geldkonto |
| Jahresabschluss | fertig: Einnahmen-Ausgaben-Rechnung je Tätigkeitsbereich (A–D, Kennzahl im Kontenstamm), Überschussrechnung mit zwei Vorjahren, Bankbestände, Anlagevermögen mit linearer AfA (Monate im Erstjahr, Spiegel und Wertentwicklung), PDF mit wählbaren Teilen EAR / Steuererklärung (3 Jahre) / Anlagevermögen, Ablage in Paperless |
| Mitgliedsanträge | fertig: öffentliches Formular `/beitritt` ohne Anmeldung (auch Familien, Beitragsart je Person, SEPA-Lastschriftmandat online, Zustimmungen, Bot-Schutz), Eingangsbestätigung per E-Mail, Arbeitsvorrat für den Kassenwart, Prüfung mit Dublettenhinweis, Ablehnung mit Begründung, **Übernahme** legt Mitglieder, Verträge, gemeinsamen Zahler, SEPA-Mandat und je Person einen Benutzer (Rolle Mitglied, Einmal-Link) an **Vertragsangebot** (#12, Migration `050_vertragsangebote.sql`): In „Mitgliedsanträge“ → „Vertragsangebot erstellen“ bereitet der Vorstand den Antrag vor – Personen aus dem Mitgliederstamm ohne Mitgliedschaft (Interessenten, Schnupperer) oder neu erfasst, Familie, Mitgliedschaft, bis zu 2 Trainingseinheiten je Person, Eintritt, Hinweis (gleiche Regeln wie das Formular). Verschickt wird nur ein persönlicher Link `/beitritt?angebot=…` (32-Byte-Zufallsschlüssel, gespeichert nur als SHA-256-Hash; keine Daten in E-Mail oder Adresse); zum Öffnen fragt das Formular das Geburtsdatum ab (5 Fehlversuche, dann gesperrt), gültig 30 Tage, einmal verwendbar, „Neu senden“ ersetzt den Link, „Zurückziehen“ macht ihn ungültig. Es wird **alles übernommen**, was bekannt ist (Personen, Anschrift, Kontakt, Verträge, Eintritt, Bankverbindung aus dem Stamm bzw. vom Vorstand erfasst – nach außen nur gekürzt angezeigt); ist der Antrag vollständig, sieht die Person nur eine Übersicht mit Beiträgen/Fälligkeit und **ein Häkchen + „Bestätigen“** (Mandat, Satzung, Datenschutz, Kündigungsfristen in einem; „Angaben ändern“ öffnet das volle Formular, fehlt etwas, kommt direkt das Formular). Die Antwort landet als Antrag im Eingang bzw. Arbeitsvorrat; bei der Übernahme (Freigabe) wird der Stammsatz aus dem Angebot Mitglied (keine Dublette), die Verträge werden angelegt und je neuem Mitglied automatisch die **Mitgliederinformation** erzeugt (mit Paperless dort abgelegt) und zum Druck geöffnet. Personensuche im Dialog lädt alle Kandidaten einmal und sucht im Feld (behebt das Springen nach dem ersten Buchstaben). **Aktive Mitglieder** sind ebenfalls auswählbar (Vertragsänderung, z. B. zusätzliches Training; Anzeige „Mitglied Nr. … · zahlt: …“, laufende Verträge vorbelegt); die Bankverbindung „aus dem Stamm“ berücksichtigt den **abweichenden Zahler**: wer nicht Selbstzahler ist (Stamm „ADRNRKIH“ bzw. Zahler eines laufenden Vertrags), bekommt IBAN/BIC des Zahlers mit dem Zahler als Kontoinhaber. Bei der Übernahme bleibt das Mitglied mit Nummer, Zahler und Mandat unverändert, nur noch nicht laufende Verträge werden ergänzt (Zahler wie bei den laufenden Verträgen); Hinweise im Ergebnis bei bereits laufendem Vertrag, zweiter Mitgliedschaft oder abweichender Bankverbindung; die E-Mail bestätigt die Vertragsänderung, kein neuer Portalbenutzer. Ausgetretene nur über den Mitgliederstamm (Wiedereintritt). **Erweiterung**: bei aktiven Mitgliedern ist die Mitgliedschaft optional (z. B. nur Training dazu; ohne neue Mitgliedschaft nur bestehende Mitglieder, mindestens ein Vertrag) – die aktuellen Verträge werden angezeigt und per „Aktuelle Verträge vorschlagen“ übernommen; im Formular „Mitgliedschaft (optional) – keine Änderung“. Die Bankverbindung aus dem Stamm bzw. vom abweichenden Zahler steht im Dialog **maskiert** (Kontoinhaber, IBAN gekürzt; „Andere Bankverbindung“ zum Überschreiben) und wird so ins Angebot übertragen (`GET /mitgliedsantraege/angebote/personen/:adrnr/bank`). Die **E-Mail** (Betreff und Text) ist im Dialog anpassbar – Vorlage mit Platzhaltern `{Name}`, `{Link}`, `{GueltigBis}`, `{Verein}` (`GET /mitgliedsantraege/angebote/mailvorlage`; fehlt `{Link}`, wird der Link angehängt). Endpunkte: `GET/POST /mitgliedsantraege/angebote`, `GET /mitgliedsantraege/angebote/personen`, `POST /mitgliedsantraege/angebote/:id/erneuern|zurueckziehen` (`tco.antraege:edit`), öffentlich `POST /antrag/angebot` |
| Schnuppertraining | fertig (#86): öffentliches Formular `/schnuppertraining` ohne Anmeldung (Name, Alter, Tennis-Erfahrung, Spielstärke, E-Mail/Handy, Wunschtage/-zeiten, Erziehungsberechtigte bei Minderjährigen, Einwilligung, Bot-Schutz) – Person im Mitgliederstamm mit Kategorie **Schnuppertraining** (ohne Mitgliedsnummer/Eintritt), App „Schnuppertraining“ im Bereich **Jugend** für Trainer mit eigenen Rechten (Status, Einheiten, Trainer, Notiz, WhatsApp/Mail), Arbeitsvorrat, **Beitrittslink** `/beitritt?schnupper=…` mit vorbelegtem Antrag; die Übernahme des Antrags macht **denselben Stammsatz** zum Mitglied. Ausbaustufe (offen): Portalbenutzer für Schnupperer per Einstellung. **In „Meine Trainingszeiten“ (#21):** Abschnitt „Schnuppertraining“ mit den Kindern im Schnuppertraining (Status, Spielstärke, Wunschtermine, Kontakt, zuletzt, Anzahl „n× von 2 kostenlos“) – nur mit `tco.schnupper:display`; bei Trainingsart „Schnuppertraining“ im Erfassungsdialog die Teilnehmer auswählen (`tco.schnupper:edit`), je Kind mit dem wievielten Mal. Gespeichert je Kind, Tag und Trainer in `tco.schnupper_einheiten` (Migration `047_schnupper_einheiten.sql`); abgeleitet werden 1./2. Einheit (erste zwei Tage), Trainer (wenn leer) und Status („Termin vereinbart“ ab der ersten, „Schnuppern absolviert“ ab der zweiten Einheit, nie zurück). Löschen der Zeit bzw. Wechsel der Trainingsart entfernt die Einheiten des Tages. `GET /jt/meine/schnupper?monat=`, `POST /jt/meine/zeiten` mit `teilnehmer`; die App Schnuppertraining zeigt die Anzahl je Kind |
| Registrierungen | fertig: Mitglieds-Registrierungen für den Kassenwart (Abgleich über Geburtsdatum bzw. Mitgliedsnummer, Freigabe als Mitglied oder Hallennutzer, Ablehnung mit Begründung per E-Mail) |
| Produkte | fertig: alle Produkte (Halle, Getränke, Speisen, Sonstiges) mit Preisen je Zeitraum, Gästepreis und Erlöskonto; neuer Preis ab Stichtag, Anlegen, Beenden; Zeitfenster der Halle weiter in den Hallenpreisen |
| Kontenstamm | fertig: Konten (Nr., Bezeichnung, Kennzahl, Profit-Center) mit Buchungen und Saldo je Jahr (Fenster 6 Jahre), Kontenverwendung je Geschäftsjahr mit Vorschlag, Filter, Pflege der Jahresanfangs- und Endbestände der Geldkonten mit Abgleich gegen die Saldenrechnung |

Gegenüber SAP behoben: Rechnungsbetrag = Summe der Positionen (manuelle Positionen mit Menge), Status springt beim Neudruck
nicht mehr zurück, Preis eines Einzeltermins aus dem eigenen Datum, robuste Namenszuordnung, keine 999er-Grenze der Rechnungsnummer.
FI: Storno nimmt die Rechnungszahlung zurück, Notizen gehen nicht mehr verloren, Bankdatei wird über die IBAN gegen das Konto geprüft,
eine einzige Saldenrechnung, Paperless-Fehler werden angezeigt, Nummernvergabe mit Sperre, Belegzuordnungen mit Begründung rücknehmbar.

**Übernahme aus SAP:** Report `ZTCO_ARCHIVE` exportiert die Tabellen als CSV → *TC Oberthal → Stammdaten → Übernahme aus SAP*
(mehrere Dateien auf einmal, Tabelle aus dem Dateinamen, Prüfung vor dem Schreiben).

## E-Mail-Versand (n8n)

Alle E-Mails des Portals (Rechnungen, Verzehr, Mitglieder, Registrierung, Mitgliedsanträge, Kennwort-Links) laufen über **einen**
n8n-Workflow: [`docs/n8n/tco-mailversand.json`](docs/n8n/tco-mailversand.json), Anleitung und Aufrufformat in
[`docs/n8n/MAILVERSAND.md`](docs/n8n/MAILVERSAND.md). Einbindung im Portal: *Administration → Anbindungen → E-Mail-Versand (n8n)*
(Webhook-URL, Schlüssel, Ersatzabsender je Anwendung).

**Absender** – genommen wird die erste Adresse, für die n8n ein SMTP-Konto hat (`KONTEN` im Knoten „Mail aufbereiten“):

1. **der Bearbeiter** – der angemeldete Benutzer, der den Versand auslöst (seine E-Mail aus der Benutzerverwaltung, Name „Anzeigename | Verein“);
2. **Ersatz je Anwendung** aus den Stammdaten (`*` = alle übrigen Anwendungen);
3. **Standard** des Workflows.

| Absender | SMTP-Knoten in n8n |
|---|---|
| torsten.laub@tc-oberthal.de (Standard) | „E-Mail senden (SMTP)“ |
| benjamin.hartyniuk@tc-oberthal.de | „E-Mail senden (SMTP Benjamin)“ |

Hat der Bearbeiter kein SMTP-Konto, geht die Mail über Ersatz bzw. Standard und **Antworten gehen per Reply-To an den Bearbeiter**
(außer bei vorgegebener Antwortadresse oder wenn er selbst Empfänger ist). Ohne Anmeldung (Registrierung, Online-Antrag,
Passwort vergessen) und in Hintergrundläufen gilt immer Ersatz bzw. Standard. Technisch kennt `mailSenden` den Bearbeiter über den
Anfragekontext (`server/src/kontext.ts`, AsyncLocalStorage) – Aufrufer müssen nichts durchreichen; `persoenlich: false` schaltet das ab.
Der Kern nutzt den Versand des Moduls über `ServerModule.mailer` (Kennwort-Links).

Weiterer eigener Absender: Adresse in `KONTEN` eintragen, SMTP-Knoten mit eigenen Zugangsdaten anlegen und im Knoten „SMTP-Konto“ eine Regel ergänzen.

## API-Schlüssel für Fremdsysteme

Unter **Administration → API-Schlüssel** legt man je Projekt/Modul Schlüssel an (z. B. `n8n` für `transport`)
und wählt die Berechtigungen aus diesem Modul. Der Schlüssel (`pk_<modul>_…`) wird **nur einmal** angezeigt;
gespeichert wird nur sein SHA-256-Hash.

- gilt ausschließlich für `/api/m/<modul>/…` (plus `GET /api/key` als Verbindungstest), nie für Benutzer, Rollen oder andere Module
- kein Cookie, kein CSRF-Header nötig: `Authorization: Bearer pk_transport_…`
- Änderungsbelege tragen den Benutzer `api:<name>`
- sperren/entsperren (mit Begründung), neuen Schlüssel erzeugen (alter sofort ungültig), optionales Ablaufdatum
- nach 20 ungültigen Schlüsseln je IP 15 Minuten Pause

```bash
K=pk_transport_...
curl -H "Authorization: Bearer $K" https://portal.example/api/key
curl -H "Authorization: Bearer $K" -H 'Content-Type: application/json' \
     -d '{"kundenname":"Brauerei Becker","land":"DE","plz":"66386","ort":"St. Ingbert"}' \
     https://portal.example/api/m/transport/adressen          # → {"adrnr":1001}
curl -H "Authorization: Bearer $K" -H 'Content-Type: application/json' \
     -d '{"typ":"F","kunde":1001,"frachtpreis_ek":450,"frachtpreis_vk":600,"steuerrelevant":true,"dok_fehlen":false}' \
     https://portal.example/api/m/transport/auftraege         # → {"auftragsnr":"2026_0015"}
```

## Sicherheit

- Passwörter mit Argon2id, Sitzungstoken nur als Hash in der Datenbank, Cookie `HttpOnly` + `SameSite=Lax`.
- CSRF-Schutz: schreibende API-Aufrufe brauchen den Header `x-portal-request`.
- Änderungsbelege können per Trigger nicht geändert oder gelöscht werden
  (Ausnahme: bewusste Bereinigung nach Ablauf der Aufbewahrungsfrist mit `set app.allow_audit_purge = on`).
- Die Oberfläche lädt nichts von externen Servern (Schrift „72“ wird lokal ausgeliefert).
