-- Täglicher Export der Portal-Sicherung in die Nextcloud (WebDAV) – Administration → Sicherung.
create table if not exists core.backup_export (
  id                    int primary key default 1 check (id = 1),
  aktiv                 boolean not null default false,
  url                   text not null default '',      -- Nextcloud-Adresse oder vollständige WebDAV-Adresse
  benutzer              text not null default '',
  passwort              text not null default '',      -- App-Passwort der Nextcloud
  ordner                text not null default '/Portal-Sicherungen',
  uhrzeit               text not null default '02:30' check (uhrzeit ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  format                text not null default 'portal' check (format in ('portal', 'zip')),
  datei_passwort        text not null default '',      -- verschlüsselt die .portal-Datei
  mit_aenderungsbelegen boolean not null default false,
  aufbewahrung_tage     int not null default 30 check (aufbewahrung_tage between 0 and 3650),
  letzter_lauf          timestamptz,
  letzter_erfolg        timestamptz,
  letzte_meldung        text,
  letzte_datei          text,
  letzte_dauer_s        int,
  letzter_fehler        boolean not null default false
);
insert into core.backup_export (id) values (1) on conflict do nothing;
select core.enable_audit('core.backup_export', 'BACKUP_EXPORT', 'id', 'passwort,datei_passwort',
  'letzter_lauf,letzter_erfolg,letzte_meldung,letzte_datei,letzte_dauer_s,letzter_fehler');
