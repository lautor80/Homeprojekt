-- Vereinskalender: Veranstaltungen mit An-/Abmeldung, Gruppen (Mannschaftsplanung).
create table if not exists tco.kal_gruppen (
  id           serial primary key,
  name         text not null unique,
  beschreibung text,
  aktiv        boolean not null default true
);
select core.enable_audit('tco.kal_gruppen', 'KAL_GRUPPE', 'id');

create table if not exists tco.kal_gruppe_mitglieder (
  gruppe_id int  not null references tco.kal_gruppen(id) on delete cascade,
  adrnr     text not null,
  rolle     text,                                   -- z. B. Mannschaftsführer
  primary key (gruppe_id, adrnr)
);
select core.enable_audit('tco.kal_gruppe_mitglieder', 'KAL_GRUPPE', 'gruppe_id,adrnr');

create table if not exists tco.kal_events (
  id                  serial primary key,
  titel               text not null,
  beschreibung        text,
  ort                 text,
  kategorie           text not null default 'VERANSTALTUNG' check (kategorie in ('VERANSTALTUNG', 'MANNSCHAFT', 'TRAINING', 'TURNIER', 'ARBEITSEINSATZ', 'SITZUNG')),
  beginn              timestamptz not null,
  ende                timestamptz,
  ganztags            boolean not null default false,
  anmeldung           boolean not null default true,     -- An-/Abmeldung möglich
  anmeldeschluss      timestamptz,
  max_teilnehmer      int check (max_teilnehmer is null or max_teilnehmer > 0),
  begleitung          boolean not null default false,    -- Begleitpersonen erfassbar
  teilnehmer_sichtbar boolean not null default true,     -- Mitglieder sehen, wer zugesagt hat
  gruppen             int[] not null default '{}',       -- leer = alle Mitglieder
  abgesagt            boolean not null default false,
  erstellt_von        text,
  erstellt_am         timestamptz not null default now(),
  check (ende is null or ende >= beginn)
);
create index if not exists kal_events_beginn_idx on tco.kal_events (beginn);
select core.enable_audit('tco.kal_events', 'KAL_EVENT', 'id');

create table if not exists tco.kal_anmeldungen (
  event_id     int  not null references tco.kal_events(id) on delete cascade,
  adrnr        text not null,
  status       text not null check (status in ('ZUSAGE', 'ABSAGE', 'VIELLEICHT')),
  begleitung   int  not null default 0 check (begleitung between 0 and 20),
  kommentar    text,
  geaendert_am timestamptz not null default now(),
  geaendert_von text,
  primary key (event_id, adrnr)
);
select core.enable_audit('tco.kal_anmeldungen', 'KAL_ANMELDUNG', 'event_id,adrnr', '', 'geaendert_am');
