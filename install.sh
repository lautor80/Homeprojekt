#!/usr/bin/env bash
# =============================================================================
# Portalbasis – Installation
#   ./install.sh                      interaktiv (fragt Port, Module, Domain, Paperless, n8n)
#   ./install.sh --yes                mit Standardwerten, ohne Rückfragen
#   ./install.sh --paperless --n8n    Paperless-ngx und/oder n8n mitinstallieren (auch nachträglich)
# Voraussetzung: Linux (z. B. Debian/Ubuntu in Proxmox-LXC/VM) mit Internetzugang.
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")"

YES=false; MIT_PAPERLESS=""; MIT_N8N=""
for a in "$@"; do
  case "$a" in
    --yes|-y) YES=true ;;
    --paperless) MIT_PAPERLESS=j ;;
    --n8n) MIT_N8N=j ;;
    *) echo "Unbekannte Option: $a  (erlaubt: --yes, --paperless, --n8n)"; exit 1 ;;
  esac
done
source scripts/env.sh

info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m✔\033[0m  %s\n' "$*"; }
fail() { printf '\033[1;31m✘\033[0m  %s\n' "$*" >&2; exit 1; }

ask() { # ask VAR "Frage" "Default"
  local __var=$1 __q=$2 __def=$3 __ans
  if $YES; then printf -v "$__var" '%s' "$__def"; return; fi
  read -r -p "$__q [$__def]: " __ans || true
  printf -v "$__var" '%s' "${__ans:-$__def}"
}

# --- 1. Docker ----------------------------------------------------------------
if ! command -v curl >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1 && [[ $EUID -eq 0 ]]; then
    info "curl wird installiert"; apt-get update -qq && apt-get install -y -qq curl ca-certificates >/dev/null
  else
    fail "curl fehlt – bitte installieren (apt install curl)."
  fi
fi
if ! command -v docker >/dev/null 2>&1; then
  info "Docker ist nicht installiert."
  ask INSTALL_DOCKER "Docker jetzt automatisch installieren (get.docker.com)? j/n" "j"
  [[ "$INSTALL_DOCKER" =~ ^[jJyY] ]] || fail "Bitte Docker installieren und das Skript erneut starten."
  [[ $EUID -eq 0 ]] || fail "Für die Docker-Installation bitte als root bzw. mit sudo ausführen."
  curl -fsSL https://get.docker.com | sh
fi
docker compose version >/dev/null 2>&1 || fail "Docker Compose (Plugin) fehlt."
docker info >/dev/null 2>&1 || fail "Docker läuft nicht oder keine Berechtigung (Benutzer in Gruppe 'docker' oder sudo)."
ok "Docker $(docker version --format '{{.Server.Version}}') bereit"

# --- 2. Konfiguration ----------------------------------------------------------
HOST_IP=$(hostname -I 2>/dev/null | awk '{print $1}'); HOST_IP=${HOST_IP:-localhost}
if [[ -f .env ]]; then
  ok ".env vorhanden – bestehende Konfiguration wird verwendet"
else
  info "Konfiguration anlegen"
  ask PORT    "Port für das Portal" "8080"
  ask MODULES "Aktive Module (* = alle, sonst kommagetrennt)" "*"
  ask DOMAIN  "Domain für HTTPS mit eigenem Zertifikat (leer = eigener Reverse Proxy / nur HTTP)" ""
  ask SPFAD   "Ordner für Portal-Sicherungen" "./data/sicherungen"
  ask BPFAD   "Ordner für die nächtlichen Datenbank-Backups (Archiv)" "./data/backups"
  [[ -z "$MIT_PAPERLESS" ]] && ask MIT_PAPERLESS "Paperless-ngx im selben Stack mitinstallieren? j/n" "n"
  [[ -z "$MIT_N8N" ]] && ask MIT_N8N "n8n im selben Stack mitinstallieren? j/n" "n"
  sed -e "s|^PORTAL_PORT=.*|PORTAL_PORT=${PORT}|" \
      -e "s|^PORTAL_MODULES=.*|PORTAL_MODULES=${MODULES}|" \
      -e "s|^PORTAL_DOMAIN=.*|PORTAL_DOMAIN=${DOMAIN}|" \
      -e "s|^SICHERUNG_PFAD=.*|SICHERUNG_PFAD=${SPFAD}|" \
      -e "s|^BACKUP_PFAD=.*|BACKUP_PFAD=${BPFAD}|" \
      .env.example > .env
  chmod 600 .env
  env_ergaenzen >/dev/null   # Passwörter und Schlüssel zufällig erzeugen
  if [[ -n "$DOMAIN" ]]; then
    env_setzen SECURE_COOKIES true; env_setzen TRUST_PROXY true; env_setzen PORTAL_URL "https://${DOMAIN}"
  else
    env_setzen PORTAL_URL "http://${HOST_IP}:${PORT}"
  fi
  ok ".env erstellt (Passwörter zufällig erzeugt)"
fi
env_ergaenzen
if [[ "$MIT_PAPERLESS" =~ ^[jJyY] ]] && ! hat_profil paperless; then
  profil_hinzu paperless
  [[ -z "$(env_wert PAPERLESS_URL)" ]] && env_setzen PAPERLESS_URL "http://${HOST_IP}:$(env_wert PAPERLESS_PORT)"
  ok "Paperless-ngx wird mitinstalliert"
fi
if [[ "$MIT_N8N" =~ ^[jJyY] ]] && ! hat_profil n8n; then
  profil_hinzu n8n
  env_setzen N8N_HOST "${HOST_IP}"
  [[ -z "$(env_wert N8N_WEBHOOK_URL)" ]] && env_setzen N8N_WEBHOOK_URL "http://${HOST_IP}:$(env_wert N8N_PORT)/"
  ok "n8n wird mitinstalliert"
fi

# --- 3. Starten ----------------------------------------------------------------
ordner_anlegen
info "Container bauen und starten (beim ersten Mal einige Minuten) ...${COMPOSE_PROFILES:+ Zusatzdienste: ${COMPOSE_PROFILES}}"
docker compose up -d --build

info "Warte auf das Portal ..."
for i in $(seq 1 90); do
  if curl -fsS "http://localhost:${PORTAL_PORT}/api/health" >/dev/null 2>&1; then
    ok "Portal läuft"
    echo
    if [[ -n "${PORTAL_DOMAIN:-}" ]]; then
      echo "   Aufruf:  https://${PORTAL_DOMAIN}"
    else
      echo "   Aufruf:  http://${HOST_IP}:${PORTAL_PORT}"
    fi
    echo "   Beim ersten Aufruf startet der Einrichtungsassistent (Organisation + Administrator)."
    echo "   Portal-Sicherungen: ${SICHERUNG_PFAD}   Datenbank-Backups: ${BACKUP_PFAD} (täglich ${BACKUP_TIME:-02:30})"
    if hat_profil paperless; then
      echo "   Paperless-ngx: http://${HOST_IP}:${PAPERLESS_PORT}  (Benutzer ${PAPERLESS_ADMIN_USER}, Passwort ${PAPERLESS_ADMIN_PASSWORD})"
      echo "                  im Portal unter Stammdaten → Anbindungen: URL http://paperless:8000 und API-Token aus Paperless"
    fi
    if hat_profil n8n; then
      echo "   n8n:           http://${HOST_IP}:${N8N_PORT}  (beim ersten Aufruf Besitzerkonto anlegen, Workflows aus docs/n8n importieren)"
      echo "                  im Portal als Webhook-URL: http://n8n:5678/webhook/tco-mailversand"
    fi
    echo "   Update: ./update.sh"
    exit 0
  fi
  sleep 2
done
docker compose logs --tail=50 app
fail "Portal antwortet nicht. Log siehe oben."
