-- Fanshop: Kachel und Menüpunkt zum Onlineshop des Vereins (externe Seite) im Bereich „Allgemein“.
-- Alle Mitglieder sehen sie: Vorgabe der Rolle „Mitglied“ und jeder Rolle, die „Meine Daten“ (Mitglied) enthält;
-- der Verein kann das Recht in der Rollenpflege wieder entfernen oder weiteren Rollen geben.
insert into core.role_permissions (role_id, permission)
select id, 'tco.fanshop:display' from core.roles where id = 'MITGLIED'
union
select role_id, 'tco.fanshop:display' from core.role_permissions where permission = 'tco.meinedaten:edit'
on conflict do nothing;
