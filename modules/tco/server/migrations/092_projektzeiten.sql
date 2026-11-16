-- Projekte: Rückmeldung der geleisteten Stunden (Meine Daten → Meine Zeiten → Projekt; App Projekte → Zeiten).
-- Projektstunden sind unbezahlt und zählen als Eigenleistung des Projekts. Sie haben nichts mit den Trainingszeiten
-- (tco.jt_*) zu tun: kein Entgelt, kein Zeitnachweis, keine Auszahlung.

-- Mitglieder, die nicht eingeplant sind, dürfen nur auf Projekte melden, die „offen für alle Mitglieder“ sind
alter table tco.hh_projekt add column if not exists offen_fuer_alle boolean not null default false;

-- adrnr = Mitglied; ohne adrnr eine freie Angabe („Helfer“), die nur der Planer erfasst.
-- GEMELDET → BESTAETIGT oder ABGELEHNT durch den Planer; im Soll-Ist zählen nur bestätigte Stunden.
create table if not exists tco.hh_projekt_zeit (
  id              serial primary key,
  projekt_id      int not null references tco.hh_projekt (id) on delete cascade,
  vorgang_id      int references tco.hh_projekt_vorgang (id) on delete set null,
  adrnr           text,
  name            text not null check (trim(name) <> ''),
  datum           date not null,
  stunden         numeric(6,2) not null check (stunden > 0 and stunden <= 500),
  taetigkeit      text,
  status          text not null default 'GEMELDET' check (status in ('GEMELDET', 'BESTAETIGT', 'ABGELEHNT')),
  grund           text,                              -- Begründung beim Zurückweisen
  erfasst_von     text,
  erfasst_am      timestamptz not null default now(),
  entschieden_von text,
  entschieden_am  timestamptz
);
create index if not exists hh_projekt_zeit_projekt on tco.hh_projekt_zeit (projekt_id, datum, id);
create index if not exists hh_projekt_zeit_adrnr on tco.hh_projekt_zeit (adrnr, datum);
select core.enable_audit('tco.hh_projekt_zeit', 'HH_PROJEKT', 'projekt_id', '', 'erfasst_am,entschieden_am');

-- Mitglieder dürfen ihre Projektstunden melden (Vorgabe der Rolle „Mitglied“; der Verein kann es dort wieder entfernen)
insert into core.role_permissions (role_id, permission)
select 'MITGLIED', 'tco.projektzeiten:edit' where exists (select 1 from core.roles where id = 'MITGLIED')
on conflict do nothing;
