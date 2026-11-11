-- #83: Abos mit Einzelabrechnung – einzelne Termine storniert der Nutzer selbst in „Platz buchen“ (das Abo bleibt).
-- Zeitpunkt der Stornierung im Portal; der EP3-Import setzt solche Termine nicht wieder auf „Abo“ (Status 3) zurück.
alter table tco.bookings add column if not exists storno_portal timestamptz;
