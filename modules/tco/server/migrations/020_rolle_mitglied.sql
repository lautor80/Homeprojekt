-- Systemrolle „Mitglied“: eigene Mitgliedsdaten („Meine Mitgliedschaft“) und Einzelbuchung. Berechtigungen fest; der Server
-- erzwingt diesen Stand zusätzlich bei jedem Start (siehe platz/registrierung.ts, rolleSicherstellen).
insert into core.roles (id, name, description, system)
values ('MITGLIED', 'Mitglied', 'Vereinsmitglieder: eigene Mitgliedsdaten sehen, ändern und kündigen („Meine Mitgliedschaft“) sowie eigene Einzelbuchungen. Berechtigungen fest vorgegeben.', true)
on conflict (id) do update set system = true, name = excluded.name, description = excluded.description;
delete from core.role_permissions where role_id = 'MITGLIED';
insert into core.role_permissions (role_id, permission) values ('MITGLIED', 'tco.meinedaten:edit'), ('MITGLIED', 'tco.platzbuchung:edit');
