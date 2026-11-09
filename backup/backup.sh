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
  # Paperless-Datenbank mitsichern, wenn Paperless im selben Stack läuft (Dokumente selbst: Ordner PAPERLESS_PFAD/media)
  if [ -n "${PAPERLESS_DB_PASSWORD:-}" ] && pg_isready -q -h paperless-db -U paperless -d paperless 2>/dev/null; then
    pf="$DIR/paperless_${ts}.dump"
    if PGPASSWORD="$PAPERLESS_DB_PASSWORD" pg_dump -Fc -h paperless-db -U paperless -d paperless -f "$pf.tmp" && mv "$pf.tmp" "$pf"; then
      echo "$(date '+%F %T') Backup erstellt: $(basename "$pf") ($(du -h "$pf" | cut -f1))"
    else
      rm -f "$pf.tmp"; echo "Paperless-Backup FEHLGESCHLAGEN"
    fi
  fi
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
