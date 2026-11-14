# Betrieb unter Windows (Docker Desktop)

Das Portal läuft unter Windows mit **Docker Desktop (WSL 2)** – es sind dieselben Linux-Container wie auf dem Server
(Portal, Postgres, Gotenberg, Backup, optional Paperless-ngx und n8n). Windows-Ordner lassen sich als Ablageorte
einbinden, Paperless läuft lokal im selben Stack oder als eigener Container auf demselben PC.

> Stand: anhand der Docker-Compose-Konfiguration geprüft (`docker compose config`), nicht auf einem Windows-PC ausprobiert.

## Empfohlener Weg: Installation in WSL

1. **WSL und Docker Desktop:** In PowerShell (Administrator) `wsl --install` (installiert Ubuntu), neu starten.
   Docker Desktop installieren, unter *Settings → General* „Use the WSL 2 based engine“ und
   *Settings → Resources → WSL integration* „Ubuntu“ einschalten.
2. **Repository in WSL klonen** – im Linux-Dateisystem, nicht unter `C:\`:
   ```bash
   cd ~ && git clone https://github.com/lautor80/homeprojekt portal && cd portal
   ./install.sh --paperless          # optional zusätzlich --n8n
   ```
   `install.sh` erkennt Docker Desktop über die WSL-Integration; eine eigene Docker-Installation in Ubuntu ist nicht nötig.
3. **Windows-Ordner eintragen** (in `~/portal/.env`, danach `./update.sh`). Laufwerke erscheinen in WSL unter `/mnt/<laufwerk>/`:
   ```ini
   SICHERUNG_PFAD=/mnt/d/Verein/Portal/sicherungen
   BACKUP_PFAD=/mnt/d/Verein/Portal/backups
   PAPERLESS_ABLAGE_PFAD=/mnt/d/Verein/Paperless      # media, export, consume
   PAPERLESS_CONSUMER_POLLING=30                       # Eingangsordner alle 30 s prüfen
   ```
   Netzlaufwerke (NAS) zuerst in WSL einhängen, z. B. `sudo mount -t drvfs '\\nas\verein' /mnt/nas`, und dann `/mnt/nas/…` angeben.

Die `.env` aus Windows heraus bearbeiten: im Explorer `\\wsl$\Ubuntu\home\<benutzer>\portal`.

## Was darf auf ein Windows-Laufwerk?

| Daten | Einstellung | Windows-Ordner (`/mnt/c`, `/mnt/d`, NAS) |
|---|---|---|
| Portal-Sicherungen | `SICHERUNG_PFAD` | ja |
| nächtliche Datenbank-Backups | `BACKUP_PFAD` | ja |
| Paperless-Dokumente, Export, Eingangsordner | `PAPERLESS_ABLAGE_PFAD` | ja (Eingangsordner nur mit `PAPERLESS_CONSUMER_POLLING`) |
| n8n | `N8N_PFAD` | möglich, besser in WSL lassen |
| Datenbanken (Portal, Paperless), Redis, Paperless-Index | `./data/postgres`, `PAPERLESS_PFAD` | **nein** – im WSL-Dateisystem lassen |

Postgres verlangt Dateirechte und `fsync`, die Windows-Laufwerke über Docker Desktop nicht zuverlässig liefern; der Container
startet dann nicht oder die Datenbank wird langsam. Deshalb trennt `PAPERLESS_ABLAGE_PFAD` die Dokumente von Datenbank und
Index (`PAPERLESS_PFAD`). Ohne Eintrag liegt alles wie bisher unter `PAPERLESS_PFAD`.

**Eingangsordner (consume):** Linux-Dateisystem-Ereignisse kommen von Windows-Laufwerken und Netzfreigaben nicht an.
`PAPERLESS_CONSUMER_POLLING=30` lässt Paperless den Ordner alle 30 Sekunden abfragen; auf einem Linux-Server bleibt `0`.

## Paperless lokal anbinden

Im Portal unter **Administration → Schnittstellen → Anbindungen → Paperless-ngx** URL und API-Token (Paperless → Profil) eintragen:

| Paperless läuft … | URL in der Anbindung |
|---|---|
| im selben Stack (Profil `paperless`) | `http://paperless:8000` |
| als eigener Container/Stack auf demselben PC | `http://host.docker.internal:8000` |
| auf einem anderen Rechner/NAS im Heimnetz | `http://<ip-des-rechners>:8000` |

In der Paperless-Konfiguration `PAPERLESS_URL=http://<ip-des-pcs>:8000` setzen, sonst lehnt Paperless Anmeldungen aus dem
Browser anderer Rechner ab (CSRF). **Freigabelinks:** Ohne externe Adresse verschickt das Portal keine Links. Bei reinem
LAN-Betrieb die interne Adresse (`http://<ip-des-pcs>:8000`) bewusst als *Adresse für Freigabelinks* eintragen – die Links
funktionieren dann nur im Heimnetz.

## Betrieb

- **Zugriff aus dem Heimnetz:** Docker Desktop veröffentlicht die Ports auf allen Netzwerkkarten. In der Windows-Firewall
  eingehend TCP `8080` (Portal) und ggf. `8000` (Paperless), `5678` (n8n) für das private Netz freigeben.
- **Dauerbetrieb:** Docker Desktop startet erst nach der Windows-Anmeldung („Start Docker Desktop when you sign in“).
  Die Container starten danach von selbst (`restart: unless-stopped`). Der PC muss zur `BACKUP_TIME` laufen –
  Energiesparmodus/Ruhezustand abschalten oder die Uhrzeit anpassen.
- **Zeilenenden:** `.gitattributes` erzwingt LF für Skripte und Konfiguration. Wurde das Repository früher unter Windows mit
  `core.autocrlf=true` geklont und meldet der Backup-Container `set: illegal option`, neu in WSL klonen.
- **Updates:** wie unter Linux `./update.sh` in WSL.

## Alternative: Portainer auf Docker Desktop

`portainer-stack-komplett.yml` funktioniert ebenso; die Daten liegen dann in Docker-Volumes (in WSL). Windows-Ordner als
Ablageort werden dort mit dem Docker-Desktop-Pfad angegeben, z. B. `SICHERUNG_PFAD=/run/desktop/mnt/host/d/Verein/Portal/sicherungen`
(ungeprüft). Der Weg über WSL und `install.sh` ist einfacher und wird empfohlen.
