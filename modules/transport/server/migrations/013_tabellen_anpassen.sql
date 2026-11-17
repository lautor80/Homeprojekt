-- Euroflex-Tabellen anpassen: Spalten ein-/ausblenden, Spaltenfilter und Sortierung, gespeichert mit der Ansichtsvariante
-- (Auftragsliste: Liste und Baum; Kontakte: Aufträge und Dokumente des Kontakts). Doku: docs/euroflex-tabellen.md
-- Niemand verliert etwas: Jede Rolle, die Aufträge oder Kontakte sieht, erhält das Recht.
insert into core.role_permissions (role_id, permission)
select distinct role_id, 'transport.tabellen:edit' from core.role_permissions
 where permission in ('transport.auftraege:display', 'transport.kontakte:display')
on conflict do nothing;
