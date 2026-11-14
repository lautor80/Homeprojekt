# Sicherungspunkt 14.11.2026 – Stand vor dem Umbau (#232)

Fester Stand, zu dem das Portal jederzeit zurückkann: Programm **und** Daten. Das Programm ist gesichert; die
Daten liegen auf dem Server und müssen dort einmal gesichert werden (Abschnitt 2).

## 1 Was gesichert ist

| Teil | Wo | Stand |
|---|---|---|
| Programm (Quelltext) | Branch [`sicherung/2026-11-14`](https://github.com/lautor80/Homeprojekt/tree/sicherung/2026-11-14), Commit `09f1729` | **angelegt** – nicht löschen, nichts hineinmergen |
| Programm (fertiges Image) | `ghcr.io/lautor80/homeprojekt@sha256:43dc153c7bbaa1a16695b56cbfcfef270990cfba70dc4e2dd66027440f0a47c4` | **vorhanden** (aus genau diesem Commit gebaut) |
| Daten des Portals (Datenbank) | auf dem Server | **noch anlegen** – Abschnitt 2 |
| Paperless (Datenbank, Dokumente), n8n | auf dem Server | **noch anlegen** – Abschnitt 2 |
| `.env` (Passwörter, Ablageorte) | auf dem Server | mitkopieren |

Der Stand enthält alle Funktionen bis einschließlich PR #231 und den Prüfbericht (#233) – noch keinen Umbau.

**Empfohlen, zwei Minuten in GitHub:** *Releases → Draft a new release → Tag `v2026.11.14` neu anlegen, Target
`sicherung/2026-11-14` → Publish*. Die CI baut daraus das Image `ghcr.io/lautor80/homeprojekt:2026.11.14` mit
festem Namen. Aus der Sitzung heraus ließ sich kein Tag anlegen (vom System abgelehnt), deshalb der Branch; der
Weg über das Release ist nicht ausprobiert.

## 2 Daten jetzt sichern (auf dem Server)

**Wichtig:** Der Ordner der nächtlichen Backups wird aufgeräumt – alles mit Endung `.dump`, das älter ist als
`BACKUP_KEEP_DAYS` (Standard 30 Tage), wird gelöscht. Der Sicherungspunkt muss deshalb **in einen eigenen
Ordner**.

Installation mit Docker Compose (im Ordner des Portals):

```bash
docker compose exec -T backup sh /backup.sh now
mkdir -p data/sicherungspunkte/2026-11-14
cp "$(ls -1t data/backups/portal_*.dump | head -1)" \
   data/sicherungspunkte/2026-11-14/
# nur wenn Paperless im selben Stack läuft:
cp "$(ls -1t data/backups/paperless_*.dump | head -1)" \
   data/sicherungspunkte/2026-11-14/
cp .env data/sicherungspunkte/2026-11-14/env.txt
```

`data/backups` steht für den Ordner aus `BACKUP_PFAD`, `portal_` für den Namen der Datenbank (`POSTGRES_DB`). Die Dokumente von Paperless (`PAPERLESS_PFAD/media`) und
n8n (`N8N_PFAD`) sind Ordner – einmal vollständig kopieren, am besten auf ein anderes Laufwerk.

Zusätzlich oder bei Portainer: im Portal *Administration → Sicherung → Sicherung erstellen und herunterladen*
(alle Bereiche, mit Änderungsbelegen) und die Datei außerhalb des Servers aufbewahren.

## 3 Zurücksetzen

Immer **Programm und Daten zusammen** zurücksetzen. Ein älteres Programm auf einer Datenbank, in der schon
neuere Migrationen gelaufen sind, ist kein geprüfter Zustand.

**Docker Compose**

```bash
git fetch origin
git checkout sicherung/2026-11-14
docker compose up -d --build
./restore.sh data/sicherungspunkte/2026-11-14/portal_<datum>.dump
```

`restore.sh` fragt nach, hält das Portal an, leert die Datenbank, spielt den Stand ein und startet wieder.

**Portainer**

1. Stack öffnen, Variable `PORTAL_IMAGE` auf das Image aus Abschnitt 1 setzen (mit `@sha256:…` oder nach dem
   Release `:2026.11.14`), *Update the stack*.
2. Im Portal *Administration → Sicherung*: die heruntergeladene Datei hochladen und zurücksichern.

**Wieder nach vorn:** `git checkout main && ./update.sh` bzw. `PORTAL_IMAGE` wieder entfernen.

## 4 Was dabei verloren geht – und der mildere Weg

Das Zurücksetzen auf den Sicherungspunkt verwirft **alles, was danach eingegeben wurde** (Buchungen, Mitglieder,
Belege). Es ist der Notausgang, nicht der Normalfall.

Für den Normalfall gilt beim Umbau:

- Jeder Umbauschritt ist ein eigener PR. Passt ein Schritt nicht, wird **dieser PR zurückgenommen** – die Daten
  bleiben.
- Umbauschritte verschieben Anzeige und Pflege. Wo eine Migration Daten umzieht (z. B. Paperless-Zugang je
  Bereich), bleiben die alten Werte stehen, bis der Schritt abgenommen ist.
- `./update.sh` legt vor jedem Update von selbst ein Datenbank-Backup an (30 Tage aufbewahrt).

Nicht geprüft: Das Zurücksetzen selbst wurde nicht durchgespielt; die Schritte folgen `restore.sh`, `update.sh`
und `portainer-stack.yml` im Repository.
