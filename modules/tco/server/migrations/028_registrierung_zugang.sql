-- Registrierung (#10): Mitglied oder externer Hallennutzer.
--  - EXTERN: E-Mail-Bestätigung (Double-Opt-In), danach automatische Freischaltung als Hallennutzer
--  - MITGLIED: Nachweis über Geburtsdatum oder Mitgliedsnummer (Wahl des Nutzers), Freigabe durch den Kassenwart
alter table tco.registrierungen
  add column if not exists art text not null default 'EXTERN',
  add column if not exists geburtsdatum date,
  add column if not exists mitgliedsnr text,
  add column if not exists email_token_hash text,
  add column if not exists email_bis timestamptz,
  add column if not exists email_bestaetigt_am timestamptz;
alter table tco.registrierungen drop constraint if exists registrierungen_status_check;
alter table tco.registrierungen add constraint registrierungen_status_check check (status in ('EMAIL', 'OFFEN', 'BESTAETIGT', 'ABGELEHNT'));
alter table tco.registrierungen drop constraint if exists registrierungen_art_check;
alter table tco.registrierungen add constraint registrierungen_art_check check (art in ('EXTERN', 'MITGLIED'));
create unique index if not exists registrierungen_token_uq on tco.registrierungen (email_token_hash) where email_token_hash is not null;
select core.enable_audit('tco.registrierungen', 'REGISTRIERUNG', 'id', 'passwort_hash,email_token_hash', 'erstellt,ip');
