-- Mitglieder mit Portalbenutzer haben immer das Recht für Hallenbuchungen (Platz buchen).
-- Die Rolle MITGLIED enthält es im Standard; hat der Verein es dort entfernt, bekommen die Benutzer zusätzlich die Rolle HALLENNUTZER.
insert into core.user_roles (user_id, role_id)
select ur.user_id, 'HALLENNUTZER'
  from core.user_roles ur
 where ur.role_id = 'MITGLIED'
   and exists (select 1 from core.roles r where r.id = 'HALLENNUTZER')
   and not exists (select 1 from core.user_roles x join core.role_permissions rp on rp.role_id = x.role_id
                    where x.user_id = ur.user_id and rp.permission in ('tco.platzbuchung:edit', '*'))
on conflict do nothing;
