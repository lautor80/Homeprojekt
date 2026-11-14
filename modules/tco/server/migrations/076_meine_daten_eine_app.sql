-- #232 (N2): „Meine Mitgliedschaft“ und „Meine Daten“ sind eine App „Meine Daten“.
-- Ein Funktionsschalter der früheren App „Meine Mitgliedschaft“ geht in den der gemeinsamen App über.
update core.funktionen set id = 'a:tco:Meine Daten'
 where id = 'a:tco:Meine Mitgliedschaft' and not exists (select 1 from core.funktionen where id = 'a:tco:Meine Daten');
delete from core.funktionen where id = 'a:tco:Meine Mitgliedschaft';
