-- Dokumenteneingang: Regel für die E-Mail selbst am Vorgang festhalten (automatisch gewählt oder von Hand zugeordnet),
-- damit sie auch ohne abgelegtes E-Mail-Dokument zur E-Mail angezeigt wird.
alter table tco.eing_vorgaenge add column if not exists regel_id int;
alter table tco.eing_vorgaenge add column if not exists regel_name text;
