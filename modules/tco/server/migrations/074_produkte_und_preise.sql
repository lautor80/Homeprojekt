-- #232 (N4): Die App „Produkte“ heißt „Produkte und Preise“ – alle Preise des Vereins werden dort gepflegt.
-- Ein gesetzter Funktionsschalter der App zieht mit dem Namen um (die Id enthält den Namen der App).
update core.funktionen set id = 'a:tco:Produkte und Preise'
 where id = 'a:tco:Produkte' and not exists (select 1 from core.funktionen where id = 'a:tco:Produkte und Preise');
