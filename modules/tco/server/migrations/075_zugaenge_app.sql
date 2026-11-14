-- #232 (N3): Die App „Registrierungen“ heißt „Zugänge“ und fasst Registrierungen (Mitglieder, Hallennutzer),
-- Zuordnung und EP3-Abgleich zusammen. Ein gesetzter Funktionsschalter der App zieht mit dem Namen um.
update core.funktionen set id = 'a:tco:Zugänge'
 where id = 'a:tco:Registrierungen' and not exists (select 1 from core.funktionen where id = 'a:tco:Zugänge');
