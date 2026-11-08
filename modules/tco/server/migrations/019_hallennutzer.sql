-- Selbstregistrierung für Hallennutzer mit Freigabe, Zuordnung zu EP3-Kunden und Übernahme der EP3-Kennwörter.

-- Rolle „Hallennutzer“: Systemrolle (in der Rollenpflege nicht änderbar) mit GENAU einer Berechtigung – eigene
-- Einzelbuchungen. Der Server erzwingt diesen Stand zusätzlich bei jedem Start und vor jeder Freigabe.
insert into core.roles (id, name, description, system)
values ('HALLENNUTZER', 'Hallennutzer', 'Selbst registrierte Hallennutzer: nur eigene Einzelbuchungen (Platz buchen). Berechtigungen fest vorgegeben.', true)
on conflict (id) do update set system = true, name = excluded.name, description = excluded.description;
delete from core.role_permissions where role_id = 'HALLENNUTZER';
insert into core.role_permissions (role_id, permission) values ('HALLENNUTZER', 'tco.platzbuchung:edit');

-- EP3-Kunden: übernommenes Kennwort (bcrypt $2y$ aus bs_users.pw) und zugeordneter Portalbenutzer
alter table tco.kunden
  add column if not exists pw_hash     text,
  add column if not exists benutzer_id uuid references core.users(id) on delete set null;
create unique index if not exists kunden_benutzer_uq on tco.kunden (benutzer_id) where benutzer_id is not null;

-- Registrierungen (bis zur Freigabe durch die Platzverwaltung)
create table if not exists tco.registrierungen (
  id            bigserial primary key,
  benutzername  text not null,
  anzeigename   text not null,
  vorname       text, nachname text, email text not null, telefon text,
  passwort_hash text not null,                      -- argon2 (neu gesetzt) oder $2y$ (aus EP3 übernommen)
  ep3_zuid      text,                               -- EP3-Konto, mit dem EP3-Kennwort nachgewiesen
  nachricht     text,                               -- Mitteilung an den Verein
  status        text not null default 'OFFEN' check (status in ('OFFEN', 'BESTAETIGT', 'ABGELEHNT')),
  ip            text,
  erstellt      timestamptz not null default now(),
  bearbeitet_am timestamptz, bearbeitet_von text, bemerkung text,
  benutzer_id   uuid references core.users(id) on delete set null
);
create index if not exists registrierungen_status_idx on tco.registrierungen (status, erstellt);
select core.enable_audit('tco.registrierungen', 'REGISTRIERUNG', 'id', 'passwort_hash', 'erstellt,ip');
