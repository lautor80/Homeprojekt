#!/usr/bin/env bash
# =============================================================================
# Portalbasis – Installation
#   ./install.sh          interaktiv (fragt Port, Module, Domain)
#   ./install.sh --yes    mit Standardwerten, ohne Rückfragen
# Voraussetzung: Linux (z. B. Debian/Ubuntu in Proxmox-LXC/VM) mit Internetzugang.
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")"

YES=false
[[ "${1:-}" == "--yes" || "${1:-}" == "-y" ]] && YES=true

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
if [[ -f .env ]]; then
  ok ".env vorhanden – bestehende Konfiguration wird verwendet"
else
  info "Konfiguration anlegen"
  ask PORT    "Port für das Portal" "8080"
  ask MODULES "Aktive Module (kommagetrennt)" "beispiel"
  ask DOMAIN  "Domain für HTTPS mit eigenem Zertifikat (leer = eigener Reverse Proxy / nur HTTP)" ""
  DBPW=$(head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 32)
  sed -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=${DBPW}|" \
      -e "s|^PORTAL_PORT=.*|PORTAL_PORT=${PORT}|" \
      -e "s|^PORTAL_MODULES=.*|PORTAL_MODULES=${MODULES}|" \
      -e "s|^PORTAL_DOMAIN=.*|PORTAL_DOMAIN=${DOMAIN}|" \
      .env.example > .env
  [[ -n "$DOMAIN" ]] && sed -i "s|^SECURE_COOKIES=.*|SECURE_COOKIES=true|" .env
  chmod 600 .env
  ok ".env erstellt (Datenbank-Passwort zufällig erzeugt)"
fi
set -a; source .env; set +a

# --- 3. Starten ----------------------------------------------------------------
mkdir -p data/postgres data/backups data/caddy
PROFILE=()
[[ -n "${PORTAL_DOMAIN:-}" ]] && PROFILE=(--profile https)

info "Container bauen und starten (beim ersten Mal einige Minuten) ..."
docker compose "${PROFILE[@]}" up -d --build

info "Warte auf das Portal ..."
for i in $(seq 1 90); do
  if curl -fsS "http://localhost:${PORTAL_PORT}/api/health" >/dev/null 2>&1; then
    HOST_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
    ok "Portal läuft"
    echo
    if [[ -n "${PORTAL_DOMAIN:-}" ]]; then
      echo "   Aufruf:  https://${PORTAL_DOMAIN}"
    else
      echo "   Aufruf:  http://${HOST_IP:-localhost}:${PORTAL_PORT}"
    fi
    echo "   Beim ersten Aufruf startet der Einrichtungsassistent (Organisation + Administrator)."
    echo "   Backups: ./data/backups (täglich ${BACKUP_TIME:-02:30}), Update: ./update.sh"
    exit 0
  fi
  sleep 2
done
docker compose logs --tail=50 app
fail "Portal antwortet nicht. Log siehe oben."
