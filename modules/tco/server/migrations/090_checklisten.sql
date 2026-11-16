-- Checklisten für Veranstaltungen: Schritte mit Terminbezug, gültig für eine oder mehrere Veranstaltungen.
-- Eine Checkliste gehört zu einer Kategorie, hat eine verantwortliche Person und Schritte. Abgehakt wird je „Bezug“:
-- ein Bezug ist eine Veranstaltung des Vereinskalenders oder ein freier Termin. Dieselbe Checkliste lässt sich so für
-- mehrere Veranstaltungen abarbeiten (z. B. jedes Heimspiel), jede mit eigenem Stand. Ohne Bezug ist sie eine Vorlage.
create table if not exists tco.cl_kategorien (
  id    serial primary key,
  name  text not null,
  aktiv boolean not null default true
);
create unique index if not exists cl_kategorien_name_uq on tco.cl_kategorien (lower(name));
select core.enable_audit('tco.cl_kategorien', 'CL_KATEGORIE', 'id');

create table if not exists tco.cl_checklisten (
  id               serial primary key,
  titel            text not null,
  beschreibung     text,
  kategorie_id     int references tco.cl_kategorien(id),
  verantwortlich   text,                                   -- Name der verantwortlichen Person (auch ohne Benutzer)
  verantwortlich_id uuid references core.users(id) on delete set null,
  kopie_von        int,                                    -- als Kopie entstanden aus dieser Checkliste
  erstellt_am      timestamptz not null default now(),
  erstellt_von     text,
  geaendert_am     timestamptz not null default now(),
  geaendert_von    text
);
select core.enable_audit('tco.cl_checklisten', 'CL_CHECKLISTE', 'id', '', 'geaendert_am,geaendert_von');

-- Fälligkeit eines Schritts: entweder relativ zum Termin des Bezugs (tage_vor: 14 = zwei Wochen vorher, 0 = am Tag,
-- negativ = danach) oder ein festes Datum – oder keine.
create table if not exists tco.cl_schritte (
  id               serial primary key,
  checkliste_id    int not null references tco.cl_checklisten(id) on delete cascade,
  pos              int not null default 0,
  titel            text not null,
  beschreibung     text,
  verantwortlich   text,                                   -- abweichend von der Checkliste
  tage_vor         int,
  faellig          date,
  check (tage_vor is null or faellig is null)
);
create index if not exists cl_schritte_idx on tco.cl_schritte (checkliste_id, pos, id);
select core.enable_audit('tco.cl_schritte', 'CL_CHECKLISTE', 'checkliste_id,id');

-- Bezug: Veranstaltung des Vereinskalenders ODER freier Termin mit Bezeichnung
create table if not exists tco.cl_bezuege (
  id            serial primary key,
  checkliste_id int not null references tco.cl_checklisten(id) on delete cascade,
  event_id      int references tco.kal_events(id) on delete cascade,
  termin        date,
  bezeichnung   text,
  check ((event_id is not null and termin is null) or (event_id is null and termin is not null))
);
create unique index if not exists cl_bezuege_event_uq on tco.cl_bezuege (checkliste_id, event_id) where event_id is not null;
create index if not exists cl_bezuege_idx on tco.cl_bezuege (checkliste_id);
select core.enable_audit('tco.cl_bezuege', 'CL_CHECKLISTE', 'checkliste_id,id');

create table if not exists tco.cl_erledigt (
  bezug_id     int not null references tco.cl_bezuege(id) on delete cascade,
  schritt_id   int not null references tco.cl_schritte(id) on delete cascade,
  erledigt_am  timestamptz not null default now(),
  erledigt_von text,
  notiz        text,
  primary key (bezug_id, schritt_id)
);
select core.enable_audit('tco.cl_erledigt', 'CL_CHECKLISTE', 'bezug_id,schritt_id');
