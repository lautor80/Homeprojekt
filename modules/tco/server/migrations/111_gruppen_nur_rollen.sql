-- Mitgliedergruppen: Selbsteintrag auf Berechtigungsgruppen (Rollen) beschränken.
-- nur_rollen leer = jedes Mitglied darf sich in „Meine Mitgliedschaft“ selbst eintragen; sonst nur Benutzer mit
-- mindestens einer dieser Rollen. Die Beschränkung gilt auch für alle Untergruppen. Die Pflege der Gruppen
-- (Mitgliedergruppen, Mitgliedsstamm, Vereinskalender) ist davon nicht betroffen.
alter table tco.kal_gruppen add column if not exists nur_rollen text[] not null default '{}';

-- Vorbelegung: Gruppe „Vorstand“ nur für die Berechtigungsgruppe „Vorstand“ (falls es beide gibt)
update tco.kal_gruppen g
   set nur_rollen = r.ids
  from (select array_agg(id order by id) as ids from core.roles where lower(trim(name)) = 'vorstand' or upper(id) = 'VORSTAND') r
 where lower(trim(g.name)) = 'vorstand' and r.ids is not null and g.nur_rollen = '{}';
