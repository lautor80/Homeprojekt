#!/usr/bin/env bash
# Portalbasis – Update: Backup, neuen Stand holen, neu bauen, Migrationen laufen beim Start automatisch.
set -euo pipefail
cd "$(dirname "$0")"
source scripts/env.sh
env_ergaenzen      # neue Einstellungen (Ablageorte, optionale Dienste) in ältere .env übernehmen
ordner_anlegen

echo "==> Backup vor dem Update"
docker compose exec -T backup sh /backup.sh now

if [[ -d .git ]]; then
  echo "==> Neuen Stand holen"
  git pull --ff-only
fi

echo "==> Neu bauen und starten${COMPOSE_PROFILES:+ (Zusatzdienste: ${COMPOSE_PROFILES})}"
docker compose pull --ignore-buildable --quiet 2>/dev/null || true
docker compose up -d --build

for i in $(seq 1 90); do
  curl -fsS "http://localhost:${PORTAL_PORT}/api/health" >/dev/null 2>&1 && { echo "✔ Update abgeschlossen"; exit 0; }
  sleep 2
done
docker compose logs --tail=50 app
echo "✘ Portal antwortet nicht nach dem Update. Rücksicherung: ./restore.sh <backup>" >&2
exit 1
