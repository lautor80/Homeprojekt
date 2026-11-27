-- Schnuppertraining → Vertragsangebot → Mitgliedsantrag → Mitglied: durchgängiger Prozess je Schnupperer.
-- „Angefangen“: Hat die Person nach dem Schnuppern im Verein angefangen? ja/nein/offen (null), optional seit wann –
-- in jedem Status pflegbar, auch später am Mitglied. Ein Vertragsangebot aus der Schnupperverwaltung merkt sich den
-- Schnupperer (Person 1), damit Angebot, Antrag und Beitritt am Schnupper-Datensatz sichtbar sind.
alter table tco.schnupper add column if not exists angefangen boolean;      -- null = offen
alter table tco.schnupper add column if not exists angefangen_am date;
alter table tco.vertragsangebote add column if not exists schnupper_adrnr text;  -- Schnupperer (Person 1), tco.schnupper.adrnr
create index if not exists vertragsangebote_schnupper_idx on tco.vertragsangebote (schnupper_adrnr) where schnupper_adrnr is not null;
