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
| Registrierung | Auswahl **Mitglied** (Nachweis Geburtsdatum oder Mitgliedsnummer, Freigabe durch den Kassenwart mit Vorschlag im Arbeitsvorrat, Rolle „Mitglied“) oder **externer Hallennutzer** (E-Mail-Bestätigung, danach sofort freigeschaltet; ohne Mailversand Freigabe durch die Platzverwaltung mit Zuordnung zu Mitglied/EP3-Kunde), feste Systemrolle „Hallennutzer“ (nur Einzelbuchung), Übernahme der EP3-Kennwörter (bcrypt aus bs_users.pw, Kundenexport mit Spalte PW); der Kundenimport legt für alle aktiven EP3-Kunden Hallennutzer an (Anmeldename = E-Mail, „Nachname, Vorname“, Zuordnung zu Mitgliedern über ZUID/E-Mail/Name); Anmeldung mit Benutzername oder E-Mail |
| Feste Platzbelegungen | Jugendtraining, Sperrzeiten, Veranstaltungen (Platzverwaltung → Training & Sperrzeiten, EP3-Events per Import) – im Kalender für alle sichtbar, blockieren Buchungen; Kalender zeigt nur an dem Tag freigegebene Plätze |
| Meine Mitgliedschaft | Benutzerpflege: Status direkt in der Tabelle sperren, Filter aktiv/gesperrt, Einzelanlage aus Mitglied/EP3-Kunde; ausgetretene Mitglieder werden nach dem Austrittsdatum automatisch gesperrt. Selbstauskunft für Mitglieder (Systemrolle „Mitglied“: eigene Daten, Bankverbindung, Kündigung zum Jahresende + Einzelbuchung); Administration → Benutzer legt alle aktiven Mitglieder als Benutzer an (Anmeldename = E-Mail, Startkennwort per Mail oder Liste); **„Mitglieder einladen (QR-Code)“** schickt aktiven Mitgliedern ohne Benutzer einen persönlichen Link mit QR-Code (30 Tage, einmal verwendbar, neue Einladung macht ältere ungültig) per E-Mail oder als Brief-PDF – Auswahlliste mit **Livesuche** (Name, Mitgliedsnummer, E-Mail; mehrere Begriffe werden UND-verknüpft), Filter „nur noch nicht eingeladene“, „alle wählen“/„keine“ wirken bei aktiver Suche nur auf die Treffer |
| Sperren | wie SM12: Objekt beim Öffnen zur Bearbeitung gesperrt (Typ + Schlüssel der Änderungsbelege), Durchsetzung im Datenbank-Trigger, Lebenszeichen, Ablauf nach 2 Min. bzw. 15 Min. Inaktivität, Platzzeiten schon bei Auswahl; Übersicht/Aufheben unter Administration → Sperren |
| Einstellungen | Organisationsname, Logo, Akzentfarbe, Anschrift, Portal-Adresse für Links in E-Mails |
| Anbindungen | angeschlossene Systeme an einer Stelle (Administration → Anbindungen, Tabelle `core.verbindungen`): Adresse, Anmeldeart (Token, Header, Basic Auth), Zugangsdaten maskiert, Verbindungstest, Änderungsbelege ohne Geheimnis. Der Kern meldet Paperless und den E-Mail-Versand (n8n, mit Ersatzabsendern je Anwendung, Mailprotokoll `core.mail_protokoll`, Testmail und „Erneut senden“) an, Module melden eigene Verbindungen über `ServerModule.verbindungen` (TCO: EP3-Export, Rückmeldungen, Ferien) und lesen sie mit `verbindungLesen(id)` |
| E-Mail-Versand | ein generischer n8n-Workflow für alle Mails (beliebige Inhalte und Anhänge, an/cc/bcc, Antwortadresse, Entwurf); **Absender ist, wer auf „Senden“ drückt** (Anfragekontext), Rückfall auf Ersatzabsender je Anwendung und Standard – siehe [E-Mail-Versand](#e-mail-versand-n8n) |
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

## Tabellenansicht (Administration)

Administration → **Tabellenansicht** (Berechtigung `core.tabellen:display`) zeigt alle Tabellen und Sichten der
Schemas `core` und der aktiven Module – wie SE16, aber **nur lesend**.

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
| Objektseite | Beteiligte (Kunde, Unternehmer, abw. Rechnungsempfänger), Auftrags-/Fahrzeugdaten, zwei Stops, Holzträgerpositionen, Besonderheiten, Änderungshistorie |
| Rechnungen | Einzel- und Sammelrechnungen mit lückenlosen Nummern (Start je Jahr in den Stammdaten), PDF mit EPC-GiroCode, XRechnung 3.0 (UBL) |
| Versand | E-Mail-Texte D/E mit Platzhaltern, Rechnung an Paperless-ngx (Zugang unter Administration → Anbindungen) |
| Stammdaten | Firmendaten inkl. Logo, Produkte, Wertelisten (Fahrzeugtyp, Ladegut, Ladeweise, Palettentausch), E-Mail-Texte |
| Übernahme aus SAP | „Neu → Import aus SAP-Export …“: CSV-Exporte (Aufträge, Aufträge_POs, Adressen, optional Träger, Produkte, Wertelisten). Nur neue Sätze werden angelegt, Nummernkreise werden nachgezogen |

Berechtigungen: `transport.auftraege:display|edit`, `transport.rechnungen:create`, `transport.versand:execute`,
`transport.kontakte:edit`, `transport.stammdaten:edit`, `transport.import:execute`.

### Regeln für Buchhaltungs-/Belegobjekte

- Gebuchte Belege nie ändern: **Storno = Gegenbeleg** mit Verweis auf den Originalbeleg, Aktion `STORNO`
  und Pflicht-Begründung (`change(req, fn, { action: 'STORNO', reason })`).
- Belegnummern über `core.next_number('<id>', <jahr>)` – die Nummer wird nur verbraucht, wenn die
  Transaktion erfolgreich ist (lückenlos).
- Vier-Augen-Prinzip später: getrennte Berechtigungen (z. B. `:erzeugen` / `:freigeben`) anlegen und
  über Rollen trennen – kein Umbau nötig.

## Modul `tco` (TC Oberthal – Vereinsportal)

Portierung der abap2UI5-Apps des Vereinsportals. Einschalten mit `PORTAL_MODULES=tco`.
Das Datenmodell (Schema `tco`) enthält alle Vereinstabellen aus SAP; alle Apps der SAP-Navigation (`Z2UI5_TCO_MAINPAGE_V2`) sind übernommen.

| App | Stand |
|---|---|
| Hallenabrechnung | fertig: EP3-Import (n8n-Workflow `docs/n8n/tco-ep3-import.json` oder CSV), Preisfindung je Buchungsminute, Zuordnen einzeln/gesammelt/automatisch, manuelle Positionen inkl. Schlüsselliste, Rechnungs-PDF mit GiroCode, Ablage in Paperless (Neudruck = neue Version, Freigabelink, Metadaten), Versand per E-Mail (n8n-Workflow „TCO Mailversand“, Absender = Bearbeiter), Zahlung mit **Splitbuchung nach Erlöskonten** der Produkte, WhatsApp und Mailentwurf, Wiedereröffnen versendeter Rechnungen mit Begründung, Hallenpreise mit Prüfung |
| FI Belege | fertig: Buchungsliste je Zeitraum/Konto mit Jahresanfang, Tagessaldo und aktuellem Saldo, Bankimport (CSV-Umsatzexport) mit Abgleich, Gegenkonto- und Belegvorschlag, Aufteilung (z. B. SumUp-Gebühren), manuelle Buchung für Kasse/Konten ohne Bankdatei, Hallenrechnung zuordnen (Teilzahlung), Belege aus Paperless zuordnen/entfernen, Beleg einer früheren Zahlung übernehmen, Notizen, **Storno per Gegenbuchung** – FI-Belege sind in der Datenbank gegen Ändern und Löschen gesperrt |
| Sollstellung | fertig: Gläubigerdaten mit Prüfung (IBAN, Gläubiger-ID), Vorschlag je Sollmonat (Turnus, Laufzeit, Beitragsstamm, Zahler am Vertrag bzw. abweichender Zahler, Mandat, Ausschlussgründe), einzelne Positionen abwählbar, SEPA-Datei pain.008.001.02 im Linear-Layout (je Zahler und Mandat eine Lastschrift), PDF-Protokoll mit Ablage in Paperless, Storno. **Verbucht wird nur in FI Belege:** der Bankimport erkennt die Sammelgutschrift und bucht sie je Position auf die Erlöskonten; ein Storno dort öffnet den Lauf wieder |
| Jugendtraining | fertig: Trainingszeiten erfassen/importieren (n8n, Nextcloud), Zeitnachweise als PDF mit Ablage in Paperless, Trainer und Trainerentgelte, als bezahlt kennzeichnen |
| Clubhausabrechnung | fertig: Getränkerechnungen, Belegzuordnung, Forderungsliste berechnen und ablegen, Getränkepreise, Absatz und Diagramme |
| Mitglieder | fertig: Stammdaten, Bank & SEPA-Mandat, Verträge, Familie & Schlüssel, Dokumente (Paperless), Notizen, Unterlagen (Aufnahmeantrag, Mitgliederinformation) drucken/ablegen/versenden, Neuanlage mit Vertrag |
| Vereinsübersicht | fertig: Dashboard auf der Startseite mit KPI-Kacheln/Cards je Bereich (Mitglieder, Clubhaus, Finanzen, Jugend, Halle), Geschäftsjahr, Diagramme (Mitgliederentwicklung, Clubheimerträge, Einnahmen/Ausgaben/Kontostand mit Jahres-/Kontenauswahl, Trainingsstunden je Trainer, Hallenbuchungen Abo/Einzel), Liquidität, Detail-Popups, Beitragsstufenwechsel Jugendliche → Erwachsene mit Bestätigung und Änderungsbeleg |
| Mitglieder-Analyse, Teilnehmer Jugendtraining, Dokumenten-Upload | fertig: Grid-Tabelle mit serverseitiger Gruppierung/Zwischensummen, 14 Filter, Sortierung, Spaltenauswahl, Anzeigevarianten (eigene/globale), Kennzahlen, SVG-Diagramme, CSV-Export; Teilnehmerliste Jugendtraining mit Filter Alle/Mitglieder/Nichtmitglieder, Suche, Mehrfachauswahl und „E-Mail an Auswahl“ (BCC), Detail mit Verträgen; Mehrfach-Upload von Belegen nach Paperless mit Dokumenttyp, Korrespondent, Datum, Tags, Speicherpfad, Notiz und Statusliste |
| Beiträge | fertig: Beitragsstamm mit zeitabhängigen Beträgen (lückenlos, letzter Zeitraum offen), neuer Betrag ab Datum teilt den Zeitraum, Löschen verlängert den Vorgänger, Prüfungen (Pflichtfelder, Erlöskonto im Kontenstamm, Lücken/Überschneidungen), aktiv/inaktiv, Hinweis auf bestehende Sollstellungspositionen, Erstbefüllung aus den Verträgen, Verträge je Beitragsart |
| Beitragsforecast | fertig: Hochrechnung Basisjahr/Folgejahr je Monat und Vertragsart aus den laufenden Verträgen (Stichtag Monatserster, Januar alle, Juli ohne Spende, übrige Monate Jugendtraining), Vorjahr als Vergleich, Säulendiagramm, Mitglieder als dritte Stufe |
| Einnahmen & Ausgaben | fertig: Kennzahlen Einnahmen/Ausgaben/Gewinn/Geldbestand, Abgleich mit der Veränderung der Geldbestände, Säulendiagramm je Monat, Monats- und 5-Jahres-Tabelle, Geldkonten mit Anfangsbestand/Zugang/Abgang, Einnahmen und Ausgaben je Konto mit Vorjahr, Liquidität, Monatsverlauf je Geldkonto |
| Jahresabschluss | fertig: Einnahmen-Ausgaben-Rechnung je Tätigkeitsbereich (A–D, Kennzahl im Kontenstamm), Überschussrechnung mit zwei Vorjahren, Bankbestände, Anlagevermögen mit linearer AfA (Monate im Erstjahr, Spiegel und Wertentwicklung), PDF mit wählbaren Teilen EAR / Steuererklärung (3 Jahre) / Anlagevermögen, Ablage in Paperless |
| Mitgliedsanträge | fertig: öffentliches Formular `/beitritt` ohne Anmeldung (auch Familien, Beitragsart je Person, SEPA-Lastschriftmandat online, Zustimmungen, Bot-Schutz), Eingangsbestätigung per E-Mail, Arbeitsvorrat für den Kassenwart, Prüfung mit Dublettenhinweis, Ablehnung mit Begründung, **Übernahme** legt Mitglieder, Verträge, gemeinsamen Zahler, SEPA-Mandat und je Person einen Benutzer (Rolle Mitglied, Einmal-Link) an |
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
