-- ---------------------------------------------------------------------------
-- API-Schlüssel für Fremdsysteme (z. B. n8n, Webformulare).
-- Jeder Schlüssel gehört zu genau einem Modul (Projekt) und darf nur dessen
-- Schnittstellen /api/m/<modul>/... mit den hinterlegten Berechtigungen nutzen.
-- Gespeichert wird nur der SHA-256-Hash; der Schlüssel selbst wird einmalig angezeigt.
-- ---------------------------------------------------------------------------
create table core.api_keys (
  id           uuid primary key default gen_random_uuid(),
  module       text        not null,
  name         text        not null,
  prefix       text        not null,               -- erkennbarer Anfang, z. B. pk_transport_AbC1
  key_hash     text        not null unique,
  permissions  text[]      not null default '{}',
  expires_on   date,
  active       boolean     not null default true,
  created_at   timestamptz not null default now(),
  created_by   text        not null,
  last_used_at timestamptz,
  last_used_ip text,
  unique (module, name)
);
select core.enable_audit('core.api_keys', 'API_KEY', 'module,name', 'key_hash',
                         'id,created_at,last_used_at,last_used_ip');
