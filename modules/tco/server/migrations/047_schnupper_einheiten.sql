-- Schnuppertraining in „Meine Trainingszeiten“ (#21): Teilnehmer je Schnuppertraining-Einheit eines Trainers.
-- Ein Kind kann am selben Tag bei mehreren Trainern stehen; gezählt werden die Tage (count distinct datum).
-- Die Einheiten gleichen die Schnupper-Angaben ab (1./2. Einheit, Trainer, Status), siehe schnupper/logik.ts.
create table if not exists tco.schnupper_einheiten (
  schnupper_adrnr text not null references tco.schnupper (adrnr) on delete cascade,
  datum           date not null,
  trainer_adrnr   text not null,                       -- Trainer (tco.mitgliedera.trainer), dessen Zeit die Einheit belegt
  erfasst_am      timestamptz not null default now(),
  erfasst_von     text,
  primary key (schnupper_adrnr, datum, trainer_adrnr)
);
create index if not exists schnupper_einheiten_trainer_idx on tco.schnupper_einheiten (trainer_adrnr, datum);
-- Änderungsbelege beim Mitglied (Stammsatz des Schnupperers)
select core.enable_audit('tco.schnupper_einheiten', 'MITGLIED', 'schnupper_adrnr', '', 'erfasst_am,erfasst_von');
