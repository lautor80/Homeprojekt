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
| PDF | HTML → PDF über Gotenberg (Layouts sind HTML-Templates) |
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

### Regeln für Buchhaltungs-/Belegobjekte

- Gebuchte Belege nie ändern: **Storno = Gegenbeleg** mit Verweis auf den Originalbeleg, Aktion `STORNO`
  und Pflicht-Begründung (`change(req, fn, { action: 'STORNO', reason })`).
- Belegnummern über `core.next_number('<id>', <jahr>)` – die Nummer wird nur verbraucht, wenn die
  Transaktion erfolgreich ist (lückenlos).
- Vier-Augen-Prinzip später: getrennte Berechtigungen (z. B. `:erzeugen` / `:freigeben`) anlegen und
  über Rollen trennen – kein Umbau nötig.

## Sicherheit

- Passwörter mit Argon2id, Sitzungstoken nur als Hash in der Datenbank, Cookie `HttpOnly` + `SameSite=Lax`.
- CSRF-Schutz: schreibende API-Aufrufe brauchen den Header `x-portal-request`.
- Änderungsbelege können per Trigger nicht geändert oder gelöscht werden
  (Ausnahme: bewusste Bereinigung nach Ablauf der Aufbewahrungsfrist mit `set app.allow_audit_purge = on`).
- Die Oberfläche lädt nichts von externen Servern (Schrift „72“ wird lokal ausgeliefert).
