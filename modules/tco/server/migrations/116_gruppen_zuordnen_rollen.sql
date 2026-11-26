-- Mitgliedergruppen: geschützte Zuordnung. zuordnen_rollen leer = wie bisher (wer pflegen darf, ordnet zu; Mitglieder
-- tragen sich selbst ein). Sonst dürfen nur Benutzer mit mindestens einer dieser Berechtigungsgruppen (Rollen) der Gruppe
-- Personen zuordnen, sie austragen oder die Gruppe ändern – in jeder App (Mitgliedergruppen, Mitgliedsstamm,
-- Vereinskalender, „Meine Mitgliedschaft“), auch für die Untergruppen; das Regelwerk fasst solche Gruppen nicht an.
alter table tco.kal_gruppen add column if not exists zuordnen_rollen text[] not null default '{}';

-- Vorbelegung: Gruppe „Vorstand“ nur durch Kassenwart oder Präsident. Fehlt eine der beiden Berechtigungsgruppen, wird sie
-- (ohne Berechtigungen) angelegt, damit die Gruppe in jedem Fall geschützt ist – nur wenn es die Gruppe „Vorstand“ gibt.
insert into core.roles (id, name, description, system)
select 'KASSENWART', 'Kassenwart', 'Kassenwart des Vereins – darf u. a. der Mitgliedergruppe „Vorstand“ Personen zuordnen.', false
 where exists (select 1 from tco.kal_gruppen where lower(trim(name)) = 'vorstand')
   and not exists (select 1 from core.roles where lower(trim(name)) like 'kassenwart%' or upper(id) = 'KASSENWART')
on conflict (id) do nothing;
insert into core.roles (id, name, description, system)
select 'PRAESIDENT', 'Präsident', 'Präsident des Vereins – darf u. a. der Mitgliedergruppe „Vorstand“ Personen zuordnen.', false
 where exists (select 1 from tco.kal_gruppen where lower(trim(name)) = 'vorstand')
   and not exists (select 1 from core.roles where lower(trim(name)) like 'präsident%' or lower(trim(name)) like 'praesident%' or upper(id) in ('PRAESIDENT', 'PRÄSIDENT'))
on conflict (id) do nothing;

update tco.kal_gruppen g
   set zuordnen_rollen = r.ids
  from (select array_agg(id order by id) as ids from core.roles
         where lower(trim(name)) like 'kassenwart%' or upper(id) = 'KASSENWART'
            or lower(trim(name)) like 'präsident%' or lower(trim(name)) like 'praesident%' or upper(id) in ('PRAESIDENT', 'PRÄSIDENT')) r
 where lower(trim(g.name)) = 'vorstand' and r.ids is not null and g.zuordnen_rollen = '{}';
