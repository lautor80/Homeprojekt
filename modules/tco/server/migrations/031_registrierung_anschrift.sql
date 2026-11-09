-- Registrierung (#10): Anrede/Geschlecht und Anschrift sind Pflichtangaben; externe Hallennutzer pflegen ihre Daten selbst
-- (Berechtigung tco.meinkonto:edit in der Systemrolle HALLENNUTZER).
alter table tco.registrierungen
  add column if not exists anrede text,
  add column if not exists strasse text,
  add column if not exists plz text,
  add column if not exists ort text;
