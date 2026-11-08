-- Platzbuchung für Freiplätze und Halle (grob angelehnt an das EP3-Buchungssystem):
-- Plätze mit Gültigkeit, Öffnungszeiten, Zeitraster, Buchungsdauern, Vorlauf und Stornofrist.
-- Die Buchungen selbst stehen wie die EP3-Buchungen in tco.bookings (gleiche Hallenabrechnung).

create table if not exists tco.plaetze (
  id           serial primary key,
  name         text    not null,                       -- Bezeichnung = tco.bookings.platz
  art          text    not null default 'FREI' check (art in ('HALLE', 'FREI')),
  aliase       text    not null default '',            -- weitere Bezeichnungen (z. B. aus EP3), kommagetrennt
  sort         integer not null default 0,
  gueltig_von  date    not null default current_date,
  gueltig_bis  date    not null default '9999-12-31',
  wochentage   text    not null default '1234567',     -- 1 = Montag … 7 = Sonntag
  zeit_von     time    not null default '08:00',
  zeit_bis     time    not null default '22:00',
  raster       integer not null default 60 check (raster in (15, 30, 60)),  -- Minuten
  dauer_min    integer not null default 60,            -- Minuten
  dauer_max    integer not null default 120,           -- Minuten
  vorlauf_min  integer not null default 0,             -- Stunden: frühestens so lange vor Beginn buchbar
  vorlauf_max  integer not null default 14,            -- Tage: höchstens so weit im Voraus buchbar
  storno_frist integer not null default 24,            -- Stunden: Ändern/Stornieren bis so lange vor Beginn
  max_offen    integer not null default 0,             -- kommende Einzelbuchungen je Mitglied und Platz (0 = unbegrenzt)
  abrechnen    boolean not null default true,          -- Preise aus den Hallenpreisen; sonst kostenfrei
  aktiv        boolean not null default true,
  hinweis      text,
  constraint plaetze_name_uq unique (name),
  constraint plaetze_zeit_ck check (zeit_von < zeit_bis),
  constraint plaetze_dauer_ck check (dauer_min > 0 and dauer_min <= dauer_max),
  constraint plaetze_gueltig_ck check (gueltig_von <= gueltig_bis)
);
select core.enable_audit('tco.plaetze', 'PLATZ', 'id');

-- Portalbuchungen: buchender Benutzer und Herkunft (EP3-Importe bleiben ohne Kennzeichen)
alter table tco.bookings add column if not exists benutzer_id uuid references core.users(id) on delete set null;
alter table tco.bookings add column if not exists quelle text;
create index if not exists bookings_datum_platz on tco.bookings (datum, upper(platz));
create index if not exists bookings_benutzer on tco.bookings (benutzer_id) where benutzer_id is not null;
