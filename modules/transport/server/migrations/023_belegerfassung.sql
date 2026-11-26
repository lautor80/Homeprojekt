-- Auftrag aus Beleg (Belegerfassung): Ein Frachtauftrag des Kunden (PDF/Bild) füllt die Erfassungsmaske vor – gespeichert wird
-- erst durch den Benutzer. Doku: docs/euroflex-belegerfassung.md

-- Leseprofile: je Layout, das die Erkennung kennt, eine Zeile. aktiv = das Layout wird beim Lesen berücksichtigt;
-- kunde = bevorzugter Kunde, der gewählt wird, wenn er unter mehreren Treffern des Kundenabgleichs ist.
create table if not exists transport.beleg_profile (
  layout       text primary key check (layout in ('bestellung', 'ladeauftrag', 'allgemein')),
  bezeichnung  text not null,
  aktiv        boolean not null default true,
  kunde        integer,                -- adrnr; bewusst ohne Fremdschlüssel: der SAP-Neuaufbau leert transport.adressen per truncate
  updated_at   timestamptz not null default now()
);
insert into transport.beleg_profile (layout, bezeichnung) values
  ('bestellung', 'Bestellung über Frachtkosten'),
  ('ladeauftrag', 'Ladeauftrag / Transportauftrag'),
  ('allgemein', 'Allgemein (Schlagworte)')
on conflict do nothing;
drop trigger if exists beleg_profile_touch on transport.beleg_profile;
create trigger beleg_profile_touch before update on transport.beleg_profile
  for each row execute function core.touch_updated_at();
select core.enable_audit('transport.beleg_profile', 'LESEPROFIL', 'layout');

-- „Auftrag aus Beleg“ (Drag & Drop) bekommt jede Rolle, die Aufträge bearbeiten darf.
insert into core.role_permissions (role_id, permission)
select role_id, 'transport.belegerfassung:create' from core.role_permissions where permission = 'transport.auftraege:edit'
on conflict do nothing;

-- „Auftrag aus Posteingang anlegen“: Rollen, die Aufträge UND den Posteingang bearbeiten dürfen.
insert into core.role_permissions (role_id, permission)
select a.role_id, 'transport.belegeingang:create'
  from core.role_permissions a join core.role_permissions e on e.role_id = a.role_id and e.permission = 'transport.eingang:edit'
 where a.permission = 'transport.auftraege:edit'
on conflict do nothing;

-- Leseprofile pflegen: Rollen, die die Stammdaten pflegen.
insert into core.role_permissions (role_id, permission)
select role_id, 'transport.leseprofile:edit' from core.role_permissions where permission = 'transport.stammdaten:edit'
on conflict do nothing;
