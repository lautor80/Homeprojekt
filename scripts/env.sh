#!/usr/bin/env bash
# Gemeinsame Helfer für install.sh / update.sh: .env aus .env.example ergänzen, Ordner anlegen, Profile bestimmen.
# Wird mit "source scripts/env.sh" eingebunden (Arbeitsordner = Installationsordner).

zufall() { head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c "${1:-32}"; }

# Wert in der .env setzen (vorhandene Zeile ersetzen, sonst anhängen)
env_setzen() { # env_setzen NAME WERT
  local name=$1 wert=$2
  if grep -q "^${name}=" .env; then
    sed -i "s|^${name}=.*|${name}=${wert//|/\\|}|" .env
  else
    printf '%s=%s\n' "$name" "$wert" >> .env
  fi
}

env_wert() { grep -E "^$1=" .env 2>/dev/null | tail -1 | cut -d= -f2-; }

# Fehlende Einträge aus .env.example übernehmen (ältere Installationen), __ZUFALL__ je Eintrag neu erzeugen
env_ergaenzen() {
  local neu=0 zeile name wert
  while IFS= read -r zeile; do
    [[ "$zeile" =~ ^([A-Z_][A-Z0-9_]*)=(.*)$ ]] || continue
    name=${BASH_REMATCH[1]}; wert=${BASH_REMATCH[2]}
    grep -q "^${name}=" .env && continue
    # Projektname nie nachträglich setzen: sonst entstünden neue Container neben den alten
    [[ "$name" == "COMPOSE_PROJECT_NAME" ]] && continue
    [[ "$wert" == "__ZUFALL__" ]] && wert=$(zufall 32)
    [[ $neu -eq 0 ]] && printf '\n# ergänzt am %s\n' "$(date +%F)" >> .env
    printf '%s=%s\n' "$name" "$wert" >> .env
    neu=$((neu + 1))
  done < .env.example
  # noch nicht ersetzte Platzhalter (z. B. aus einer kopierten .env.example)
  while grep -q "=__ZUFALL__$" .env; do
    name=$(grep -m1 "=__ZUFALL__$" .env | cut -d= -f1)
    env_setzen "$name" "$(zufall 32)"
  done
  [[ $neu -gt 0 ]] && echo "   .env um $neu Einstellung(en) ergänzt (Ablageorte, optionale Dienste)"
  return 0
}

# Profil (paperless, n8n, https) in COMPOSE_PROFILES aufnehmen
profil_hinzu() {
  local p=$1 alt
  alt=$(env_wert COMPOSE_PROFILES)
  [[ ",${alt}," == *",${p},"* ]] && return 0
  env_setzen COMPOSE_PROFILES "${alt:+${alt},}${p}"
}

hat_profil() { [[ ",$(env_wert COMPOSE_PROFILES)," == *",$1,"* ]]; }

# Ablageorte anlegen und Rechte setzen (App, Paperless und n8n laufen als UID 1000)
ordner_anlegen() {
  set -a; source .env; set +a
  local s=${SICHERUNG_PFAD:-./data/sicherungen} b=${BACKUP_PFAD:-./data/backups}
  mkdir -p data/postgres data/caddy "$s" "$b"
  besitz() { chown -R 1000:1000 "$1" 2>/dev/null || sudo chown -R 1000:1000 "$1" 2>/dev/null || chmod -R 777 "$1"; }
  besitz "$s"
  if hat_profil paperless; then
    local p=${PAPERLESS_PFAD:-./data/paperless}
    local a=${PAPERLESS_ABLAGE_PFAD:-$p}
    mkdir -p "$p"/{db,redis,data} "$a"/{media,export,consume}
    besitz "$p/data"; besitz "$a/media"; besitz "$a/export"; besitz "$a/consume"
  fi
  if hat_profil n8n; then
    local n=${N8N_PFAD:-./data/n8n}
    mkdir -p "$n"; besitz "$n"
  fi
  # HTTPS-Profil folgt der Domain
  [[ -n "${PORTAL_DOMAIN:-}" ]] && profil_hinzu https
  set -a; source .env; set +a
  export COMPOSE_PROFILES
}
