-- Mailprotokoll: fehlgeschlagene Mails erneut senden.
-- nachricht: Inhalt (inkl. Anhänge) bzw. Anleitung zum Neuerzeugen – nur bei Fehlern, nie mit Zugangslinks/Kennwörtern; nach 30 Tagen bzw. erfolgreicher Wiederholung geleert.
alter table tco.mail_protokoll add column if not exists nachricht jsonb;
alter table tco.mail_protokoll add column if not exists erneut_am timestamptz;
alter table tco.mail_protokoll add column if not exists erneut_von text;
alter table tco.mail_protokoll add column if not exists erneut_status text;
