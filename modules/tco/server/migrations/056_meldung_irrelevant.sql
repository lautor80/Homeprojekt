-- #162: Kennzeichen „Für Meldung irrelevant“ in den Mitglieder-Zusatzdaten (Spielerdaten/nuLiga).
-- null = offen (noch nicht entschieden), true = für die Meldung irrelevant (wird in der Spielerübersicht nicht mehr selektiert),
-- false = Mitglied hat eine ID-Nr. und ist damit gemeldet – wird mit der ID-Nr. automatisch gesetzt.
alter table tco.mitgliedera add column if not exists meldung_irrelevant boolean;
update tco.mitgliedera set meldung_irrelevant = false where id_nr is not null and id_nr <> '';
alter table tco.mitgliedera drop constraint if exists mitgliedera_meldung_ck;
alter table tco.mitgliedera add constraint mitgliedera_meldung_ck check (not (coalesce(meldung_irrelevant, false) and id_nr is not null and id_nr <> ''));
