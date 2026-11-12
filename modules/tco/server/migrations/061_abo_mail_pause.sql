-- #11 Abo-Bewerbung: Pause für automatische E-Mails (Erinnerung, Angebote) bis einschließlich Datum
alter table tco.abo_saison add column if not exists mail_pause_bis date;
