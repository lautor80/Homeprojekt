-- SAP liefert leere Adressverweise (NUMC) als „0000000000“: als „kein Zahler“ speichern
update tco.vertraege set zahler_adrnr = null where zahler_adrnr is not null and ltrim(trim(zahler_adrnr), '0') = '';
update tco.mitglieder set adrnrkih = null where adrnrkih is not null and ltrim(trim(adrnrkih), '0') = '';
-- Vertrag, der das Mitglied selbst als Zahler nennt = kein abweichender Zahler am Vertrag
update tco.vertraege set zahler_adrnr = null where zahler_adrnr = adrnr;
update tco.mitglieder set adrnrkih = null where adrnrkih = adrnr;
