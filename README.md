# Portalbasis

Self-hosted Web-Portal im SAP-Fiori-Look – ohne SAP-Basis.
Die Basis enthält alles, was jede Anwendung braucht; die Fachlichkeit kommt als **Modul** dazu
(z. B. `tco` für den Verein, `transport` für ein Transportwesen). Beide Projekte nutzen dieselbe Basis,
jede Installation schaltet nur ihre Module ein.

| Bereich | Inhalt |
|---|---|
| Oberfläche | React + **UI5 Web Components** (SAP Horizon, Open Source), Shell mit Seitennavigation, Startseite mit Kacheln |
| Anmeldung | Benutzer/Passwort (Argon2), Sitzungen, Sperre nach Fehlversuchen, Passwortwechsel beim ersten Login |
| Berechtigungen | Rollen aus Berechtigungen „Objekt:Aktivität“, Module bringen ihre Berechtigungen selbst mit |
| Änderungsbelege | wie CDHDR/CDPOS, per Datenbank-Trigger – lückenlos, unveränderlich, mit Benutzer, Aktion und Begründung |
| Einstellungen | Organisationsname, Logo, Akzentfarbe, Anschrift, Integrations-URLs |
| PDF | HTML → PDF über Gotenberg (Layouts sind HTML-Templates); Module können PDFs auch selbst erzeugen (z. B. `transport`) |
| API-Schlüssel | Zugriff für Fremdsysteme (n8n, Webformulare) per `Authorization: Bearer …` – je Schlüssel genau ein Projekt/Modul mit ausgewählten Rechten |
| Nummernkreise | lückenlose Nummern je Objekt und Jahr (`core.next_number`) |
| Betrieb | Docker Compose, Installationsskript, tägliches Backup, Update- und Restore-Skript |

## Installation

Voraussetzung: Linux-Server (z. B. Debian 12 als Proxmox-LXC oder -VM) mit Internetzugang.

```bash
git clone <repo-url> portal && cd portal
./install.sh            # fragt Port, Module und optional eine Domain
# oder ohne Rückfragen:
./install.sh --yes
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

Hinter einem vorhandenen Reverse Proxy (z. B. Nginx Proxy Manager): Domain leer lassen,
Proxy auf `http://<server>:<PORTAL_PORT>` zeigen lassen und in der `.env` `SECURE_COOKIES=true` setzen.

### Installation über Portainer

1. In Portainer **Stacks → Add stack**, Name z. B. `portal`, **Web editor**.
2. Inhalt von [`portainer-stack.yml`](portainer-stack.yml) einfügen.
3. Unter **Environment variables** `POSTGRES_PASSWORD` mit einem langen Zufallswert setzen
   (optional `PORTAL_PORT`, Standard 8080).
4. **Deploy the stack** – danach `http://<server>:8080` öffnen und den ersten Administrator anlegen.

Alle Fachmodule sind aktiv (`PORTAL_MODULES=*`). Was jemand im Menü sieht, steuern die Rollen
(Administration → Rollen): Ein Menüpunkt erscheint nur mit der passenden Berechtigung, eine leere Gruppe
verschwindet ganz. **Update:** Stack öffnen → *Update the stack* mit *Re-pull image* – die Datenbank wird beim
Start automatisch migriert. Daten und Backups liegen in den Volumes `portal_db` und `portal_backups`.

### Betrieb

```bash
./update.sh                                   # Backup, git pull, neu bauen, Migrationen
./restore.sh data/backups/portal_<datum>.dump # Backup zurückspielen
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
| Versand | E-Mail-Texte D/E mit Platzhaltern, Rechnung an Paperless-ngx (URL + Token in den Stammdaten) |
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
Das Datenmodell (Schema `tco`) enthält bereits alle Vereinstabellen aus SAP; die Apps folgen nach Priorität.

| App | Stand |
|---|---|
| Hallenabrechnung | fertig: EP3-Import (n8n oder CSV), Preisfindung je Buchungsminute, Zuordnen einzeln/gesammelt/automatisch, manuelle Positionen inkl. Schlüsselliste, Rechnungs-PDF mit GiroCode, Ablage in Paperless (Neudruck = neue Version, Freigabelink, Metadaten), Versand per E-Mail (n8n-Workflow „TCO Mailversand aus SAP“), WhatsApp und Mailentwurf, Wiedereröffnen versendeter Rechnungen mit Begründung, Hallenpreise mit Prüfung |
| FI Belege | fertig: Buchungsliste je Zeitraum/Konto mit Jahresanfang, Tagessaldo und aktuellem Saldo, Bankimport (CSV-Umsatzexport) mit Abgleich, Gegenkonto- und Belegvorschlag, Aufteilung (z. B. SumUp-Gebühren), manuelle Buchung für Kasse/Konten ohne Bankdatei, Hallenrechnung zuordnen (Teilzahlung), Belege aus Paperless zuordnen/entfernen, Beleg einer früheren Zahlung übernehmen, Notizen, **Storno per Gegenbuchung** – FI-Belege sind in der Datenbank gegen Ändern und Löschen gesperrt |
| Sollstellung | fertig: Gläubigerdaten mit Prüfung (IBAN, Gläubiger-ID), Vorschlag je Sollmonat (Turnus, Laufzeit, Beitragsstamm, Zahler am Vertrag bzw. abweichender Zahler, Mandat, Ausschlussgründe), einzelne Positionen abwählbar, SEPA-Datei pain.008.001.02 im Linear-Layout (je Zahler und Mandat eine Lastschrift), PDF-Protokoll mit Ablage in Paperless, Storno. **Verbucht wird nur in FI Belege:** der Bankimport erkennt die Sammelgutschrift und bucht sie je Position auf die Erlöskonten; ein Storno dort öffnet den Lauf wieder |
| Jugendtraining, Clubhaus, Mitglieder, Einnahmen & Ausgaben, Beiträge, Kontenstamm | folgen |

Gegenüber SAP behoben: Rechnungsbetrag = Summe der Positionen (manuelle Positionen mit Menge), Status springt beim Neudruck
nicht mehr zurück, Preis eines Einzeltermins aus dem eigenen Datum, robuste Namenszuordnung, keine 999er-Grenze der Rechnungsnummer.
FI: Storno nimmt die Rechnungszahlung zurück, Notizen gehen nicht mehr verloren, Bankdatei wird über die IBAN gegen das Konto geprüft,
eine einzige Saldenrechnung, Paperless-Fehler werden angezeigt, Nummernvergabe mit Sperre, Belegzuordnungen mit Begründung rücknehmbar.

**Übernahme aus SAP:** Report `ZTCO_ARCHIVE` exportiert die Tabellen als CSV → *TC Oberthal → Stammdaten → Übernahme aus SAP*
(mehrere Dateien auf einmal, Tabelle aus dem Dateinamen, Prüfung vor dem Schreiben).

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
