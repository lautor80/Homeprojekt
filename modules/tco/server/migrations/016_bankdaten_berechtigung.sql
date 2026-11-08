-- Bankdaten von Personen sind ab jetzt über eigene Berechtigungen geschützt (tco.bankdaten:display/edit).
-- Übergang ohne Funktionsverlust: Rollen, die bisher Bankverbindungen ändern konnten (Mitglieder pflegen)
-- oder die SEPA-Datei herunterladen (Sollstellung ausführen), erhalten die neuen Rechte einmalig.
-- Reine Anzeigerollen sehen Bankdaten künftig maskiert. Bitte die Zuordnung danach in der Rollenpflege
-- (Bereich „Datenschutz“) prüfen und ggf. einschränken.
insert into core.role_permissions (role_id, permission)
select distinct role_id, 'tco.bankdaten:display'
  from core.role_permissions
 where permission in ('tco.mitglieder:edit', 'tco.mitglieder:*', 'tco.soll:edit', 'tco.soll:*')
on conflict do nothing;

insert into core.role_permissions (role_id, permission)
select distinct role_id, 'tco.bankdaten:edit'
  from core.role_permissions
 where permission in ('tco.mitglieder:edit', 'tco.mitglieder:*')
on conflict do nothing;
