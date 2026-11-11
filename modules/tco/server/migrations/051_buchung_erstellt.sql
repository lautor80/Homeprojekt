-- #11: Zeitpunkt und Benutzer der Anlage je Buchung (Detail in der Platzverwaltung). Bestehende Zeilen bleiben leer
-- (dort gilt das Datum „erstellt“); neue Zeilen bekommen Zeitpunkt und angemeldeten Benutzer (app.username) automatisch.
alter table tco.bookings add column if not exists erstellt_um timestamptz;
alter table tco.bookings add column if not exists erstellt_von text;
alter table tco.bookings alter column erstellt_um set default now();
alter table tco.bookings alter column erstellt_von set default nullif(current_setting('app.username', true), '');
