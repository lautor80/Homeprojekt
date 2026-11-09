-- Zentrale Anbindungen (Administration → Anbindungen): je angeschlossenem System ein Eintrag mit Adresse und
-- Zugangsdaten – wie SM59. Der Kern meldet „paperless“ an, Module melden weitere Verbindungen (z. B. n8n-Webhooks)
-- über ServerModule.verbindungen an; die Werte stehen für alle Module an einer Stelle.
--  auth_art: keine | token (Authorization: Token …, Paperless) | header (eigener Header, z. B. X-TCO-Key) | basic (Benutzer/Passwort)
--  geheimnis: Token, Header-Wert bzw. Passwort – in Änderungsbelegen und der Tabellenansicht maskiert.
create table if not exists core.verbindungen (
  id            text        primary key,
  url           text        not null default '',
  auth_art      text        not null default 'keine' check (auth_art in ('keine', 'token', 'header', 'basic')),
  auth_user     text,
  header_name   text,
  geheimnis     text,
  einstellungen jsonb       not null default '{}'::jsonb,
  geaendert_am  timestamptz not null default now(),
  geaendert_von text
);
select core.enable_audit('core.verbindungen', 'VERBINDUNG', 'id', 'geheimnis', 'geaendert_am');
