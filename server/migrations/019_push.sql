-- Push-Nachrichten aufs Handy (Web-Push): Geräte der Benutzer, abgewählte Arten und das Schlüsselpaar des Portals.
--   push_geraete    je Browser/Gerät eine Anmeldung beim Push-Dienst (endpoint) mit den Schlüsseln des Geräts
--   push_abwahl     Arten, die ein Benutzer nicht aufs Handy bekommen möchte – ohne Eintrag ist eine Art eingeschaltet
--   push_schluessel Schlüsselpaar, mit dem sich das Portal beim Push-Dienst ausweist (VAPID); entsteht beim ersten Gebrauch
-- Kein Änderungsbeleg: technische Anmeldungen der Geräte, die jeder Benutzer selbst ein- und ausschaltet.
create table if not exists core.push_geraete (
  id          bigserial primary key,
  user_id     uuid not null references core.users(id) on delete cascade,
  endpoint    text not null unique,
  p256dh      text not null,
  auth        text not null,
  name        text not null default '',
  erstellt_am timestamptz not null default now(),
  zuletzt_am  timestamptz,
  fehler      integer not null default 0
);
comment on table core.push_geraete is 'Push-Nachrichten: angemeldete Geräte je Benutzer (Web-Push)';
create index if not exists push_geraete_user_idx on core.push_geraete (user_id);

create table if not exists core.push_abwahl (
  user_id uuid not null references core.users(id) on delete cascade,
  art     text not null,
  primary key (user_id, art)
);
comment on table core.push_abwahl is 'Push-Nachrichten: vom Benutzer abgeschaltete Arten';

create table if not exists core.push_schluessel (
  id          boolean primary key default true check (id),
  oeffentlich text not null,
  privat      text not null,
  erstellt_am timestamptz not null default now()
);
comment on table core.push_schluessel is 'Push-Nachrichten: Schlüsselpaar des Portals gegenüber den Push-Diensten (VAPID)';
