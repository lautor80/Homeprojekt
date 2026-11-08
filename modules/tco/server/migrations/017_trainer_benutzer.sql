-- „Meine Trainingszeiten“: Ein Portal-Benutzer kann genau einem Trainer zugeordnet werden.
-- Der Trainer meldet damit nur für sich selbst zurück; die Zuordnung pflegt die Jugendleitung
-- (Abrechnung Jugendtraining → Entgelte → Trainer).
alter table tco.mitgliedera add column if not exists benutzer_id uuid references core.users(id) on delete set null;
create unique index if not exists mitgliedera_benutzer_uq on tco.mitgliedera (benutzer_id) where benutzer_id is not null;
