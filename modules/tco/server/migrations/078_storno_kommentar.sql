-- Platzverwaltung: auch abgerechnete Stunden lassen sich stornieren – dann mit Pflichtkommentar, der an der Buchung steht.
alter table tco.bookings add column if not exists storno_grund text;
