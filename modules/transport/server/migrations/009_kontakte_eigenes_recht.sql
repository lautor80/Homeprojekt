-- #232 (N7): Die App „Kontakte“ hat ein eigenes Recht (transport.kontakte:display) – bisher war sie mit
-- „Aufträge anzeigen“ sichtbar. Niemand verliert die App: Jede Rolle, die Aufträge sieht, erhält das neue Recht.
insert into core.role_permissions (role_id, permission)
select role_id, 'transport.kontakte:display' from core.role_permissions where permission = 'transport.auftraege:display'
on conflict do nothing;

-- Die App „Stammdaten“ heißt „Produkte und Wertelisten“ – ein gesetzter Funktionsschalter zieht mit dem Namen um.
update core.funktionen set id = 'a:transport:Produkte und Wertelisten'
 where id = 'a:transport:Stammdaten' and not exists (select 1 from core.funktionen where id = 'a:transport:Produkte und Wertelisten');
