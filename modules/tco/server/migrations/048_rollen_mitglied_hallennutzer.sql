-- „Mitglied“ und „Hallennutzer“ sind keine Systemrollen mehr: Berechtigungen pflegt ein Administrator in der Rollenpflege.
-- Das Portal legt die Rollen nur noch an, wenn sie fehlen, und überschreibt ihre Berechtigungen nicht mehr.
update core.roles set system = false, nur_admin = true where id in ('MITGLIED', 'HALLENNUTZER');
update core.roles set description = replace(description, ' Berechtigungen fest vorgegeben.', ' Wird bei Registrierung bzw. Benutzeranlage automatisch vergeben; ändern kann sie nur ein Administrator.')
 where id in ('MITGLIED', 'HALLENNUTZER');
-- Einmalig den bisher vom Code erzwungenen Stand sicherstellen (bestehende Installationen haben ihn bereits);
-- danach ändert nur noch ein Administrator die Berechtigungen.
insert into core.role_permissions (role_id, permission)
select r.id, p.perm
  from core.roles r
  join (values ('HALLENNUTZER', 'tco.meinkonto:edit'), ('HALLENNUTZER', 'tco.platzbuchung:edit'),
               ('MITGLIED', 'tco.kalender:anmelden'), ('MITGLIED', 'tco.meinedaten:edit'), ('MITGLIED', 'tco.platzbuchung:edit'), ('MITGLIED', 'tco.verzehr:edit')) p(rolle, perm)
    on p.rolle = r.id
on conflict do nothing;
-- Hallennutzer hatte bisher genau diese zwei Berechtigungen; frühere Reste (vor 031) entfernen wie zuvor beim Start
delete from core.role_permissions where role_id = 'HALLENNUTZER' and permission not in ('tco.meinkonto:edit', 'tco.platzbuchung:edit');
delete from core.role_permissions where role_id = 'MITGLIED' and permission not in ('tco.kalender:anmelden', 'tco.meinedaten:edit', 'tco.platzbuchung:edit', 'tco.verzehr:edit');
