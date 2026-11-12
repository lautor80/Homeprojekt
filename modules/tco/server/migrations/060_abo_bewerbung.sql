-- #11 Abo-Bewerbung: Saison mit einstellbaren Fristen, Bestätigungen der bisherigen Abonnenten und Warteliste der Interessenten.
-- Grundregel: Diese Tabellen erzeugen nie eine Buchung – ein Abo (tco.bookings, Status 3) entsteht nur durch die Freigabe.
create table if not exists tco.abo_saison (
  id              serial primary key,
  name            text not null,
  von             date not null,
  bis             date not null,
  bestaetigen_bis date not null,
  nachruecken_ab  date not null,
  annahme_tage    int  not null default 7,
  aktiv           boolean not null default true,
  eroeffnet_am    timestamptz not null default now(),
  erinnert_am     date
);
create table if not exists tco.abo_wunsch (
  id           serial primary key,
  saison_id    int  not null references tco.abo_saison(id) on delete cascade,
  art          text not null check (art in ('BESTAETIGUNG', 'BEWERBUNG')),
  adrnr        text,
  name         text not null,
  mitglied     boolean not null default false,
  benutzer_id  uuid,
  platz_id     int  not null,
  wochentag    int  not null check (wochentag between 1 and 7),
  von          int  not null,
  bis          int  not null check (bis > von),
  status       text not null,
  vorjahr_bid  text,
  angelegt     timestamptz not null default now(),
  entschieden  timestamptz,
  angeboten_am date,
  mail_fehler  text,
  abo_bid      text
);
create index if not exists abo_wunsch_saison on tco.abo_wunsch (saison_id, platz_id, wochentag);
select core.enable_audit('tco.abo_saison', 'ABOSAISON', 'id');
select core.enable_audit('tco.abo_wunsch', 'ABOWUNSCH', 'id');
