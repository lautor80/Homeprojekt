#!/usr/bin/env bash
# Portalbasis – Update: Backup, neuen Stand holen, neu bauen, Migrationen laufen beim Start automatisch.
set -euo pipefail
cd "$(dirname "$0")"
set -a; source .env; set +a

mkdir -p data/sicherungen
chown 1000:1000 data/sicherungen 2>/dev/null || sudo chown 1000:1000 data/sicherungen 2>/dev/null || chmod 777 data/sicherungen

echo "==> Backup vor dem Update"
docker compose exec -T backup sh /backup.sh now

if [[ -d .git ]]; then
  echo "==> Neuen Stand holen"
  git pull --ff-only
fi

PROFILE=()
[[ -n "${PORTAL_DOMAIN:-}" ]] && PROFILE=(--profile https)
echo "==> Neu bauen und starten"
docker compose "${PROFILE[@]}" up -d --build

for i in $(seq 1 90); do
  curl -fsS "http://localhost:${PORTAL_PORT}/api/health" >/dev/null 2>&1 && { echo "✔ Update abgeschlossen"; exit 0; }
  sleep 2
done
docker compose logs --tail=50 app
echo "✘ Portal antwortet nicht nach dem Update. Rücksicherung: ./restore.sh <backup>" >&2
exit 1
