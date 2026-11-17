-- Vorschläge beim Erfassen der Stops (Firma, Straße, PLZ/Ort, Zeitvorgabe aus früheren Aufträgen).
-- Doku: docs/euroflex-stop-vorschlaege.md. Jede Rolle, die Aufträge bearbeiten darf, erhält das Recht.
insert into core.role_permissions (role_id, permission)
select role_id, 'transport.vorschlaege:display' from core.role_permissions where permission = 'transport.auftraege:edit'
on conflict do nothing;
