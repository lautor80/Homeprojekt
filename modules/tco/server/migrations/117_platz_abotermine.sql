-- Platzverwaltung → Abos → „Termine“: einzelne Termine einer Abo-Serie stornieren (Recht tco.platz:abotermine,
-- Funktion tco.platz.abotermine). Wer heute die Platzverwaltung hat, bekommt das Recht dazu (in der Rollenpflege änderbar).
insert into core.role_permissions (role_id, permission)
select distinct role_id, 'tco.platz:abotermine' from core.role_permissions where permission = 'tco.platz:admin'
on conflict do nothing;
