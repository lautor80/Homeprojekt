-- #11: feste Platzbelegung „Schnuppertraining“ (Platzverwaltung und Platz buchen für den Hallenwart)
alter table tco.platzbelegungen drop constraint if exists platzbelegungen_art_check;
alter table tco.platzbelegungen add constraint platzbelegungen_art_check
  check (art in ('TRAINING', 'SCHNUPPER', 'SPERRE', 'VERANSTALTUNG'));
