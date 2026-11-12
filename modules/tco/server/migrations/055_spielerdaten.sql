-- #162: Spielerdaten aus nuLiga (Verband) – ID-Nr. und Leistungsklasse (LK) in den Mitglieder-Zusatzdaten.
-- Die LK ändert sich von Jahr zu Jahr: aktueller Wert am Mitglied, dazu der Verlauf je Jahr.
alter table tco.mitgliedera add column if not exists id_nr text;
alter table tco.mitgliedera add column if not exists lk numeric(4,1);
alter table tco.mitgliedera add column if not exists lk_stand date;

create table if not exists tco.mitglieder_lk (
  adrnr text not null,
  jahr  int not null,
  lk    numeric(4,1) not null,
  stand date not null default current_date,
  primary key (adrnr, jahr)
);

-- Rolle Sportwart; die App dürfen außerdem alle, die Mitglieder pflegen
insert into core.roles (id, name, description, system)
values ('SPORTWART', 'Sportwart', 'Sportwart: Spielerdaten (ID-Nr., LK) aus nuLiga mit den Mitgliedern abgleichen.', false)
on conflict (id) do nothing;
insert into core.role_permissions (role_id, permission) values ('SPORTWART', 'tco.sport:display'), ('SPORTWART', 'tco.sport:edit')
on conflict do nothing;
insert into core.role_permissions (role_id, permission)
select distinct role_id, p from core.role_permissions, (values ('tco.sport:display'), ('tco.sport:edit')) as x(p) where permission = 'tco.mitglieder:edit'
on conflict do nothing;
