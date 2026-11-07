#!/usr/bin/env bash
# Portalbasis – Rücksicherung eines Backups
#   ./restore.sh data/backups/portal_2026-11-07_023000.dump
set -euo pipefail
cd "$(dirname "$0")"
FILE=${1:-}
[[ -f "$FILE" ]] || { echo "Aufruf: ./restore.sh <backup-datei>"; ls -1t data/backups/*.dump 2>/dev/null | head -5; exit 1; }
set -a; source .env; set +a

read -r -p "Datenbank ${POSTGRES_DB} wird durch $(basename "$FILE") ERSETZT. Fortfahren? (ja/nein): " A
[[ "$A" == "ja" ]] || exit 1

docker compose stop app
docker compose exec -T backup sh -c "pg_restore --clean --if-exists --no-owner -d \"$POSTGRES_DB\"" < "$FILE"
docker compose start app
echo "✔ Rücksicherung abgeschlossen"
