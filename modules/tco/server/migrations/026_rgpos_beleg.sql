-- Rechnungsposition ↔ Paperless-Beleg (z. B. Screenshot der Mannschaftsaufstellung einer Sammelrechnung)
alter table tco.rgpos add column if not exists beleg_doc_id int;
