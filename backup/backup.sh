#!/bin/sh
# Datenbank-Backup mit pg_dump (Custom-Format, komprimiert) und Aufbewahrungsrotation.
#   backup.sh now   -> sofort ein Backup
#   backup.sh loop  -> täglich um BACKUP_TIME (Container-Modus)
set -eu
DIR=/backups
KEEP=${BACKUP_KEEP_DAYS:-30}

run_backup() {
  ts=$(date +%Y-%m-%d_%H%M%S)
  file="$DIR/${PGDATABASE}_${ts}.dump"
  pg_dump -Fc -f "$file.tmp" && mv "$file.tmp" "$file"
  echo "$(date '+%F %T') Backup erstellt: $(basename "$file") ($(du -h "$file" | cut -f1))"
  find "$DIR" -name "*.dump" -type f -mtime +"$KEEP" -print -delete | sed 's/^/gelöscht: /' || true
}

mkdir -p "$DIR"
case "${1:-now}" in
  now) run_backup ;;
  loop)
    echo "Backup-Dienst aktiv: täglich um ${BACKUP_TIME:-02:30}, Aufbewahrung ${KEEP} Tage"
    last=""
    while true; do
      now=$(date +%H:%M)
      today=$(date +%F)
      if [ "$now" = "${BACKUP_TIME:-02:30}" ] && [ "$last" != "$today" ]; then
        run_backup || echo "Backup FEHLGESCHLAGEN"
        last=$today
      fi
      sleep 30
    done ;;
esac
