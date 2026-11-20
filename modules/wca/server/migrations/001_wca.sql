-- WCA Zeitenkontrolle: Import von Tempo-Zeitexporten (Teamreport) und Prüfung der Zeitbuchungen (siehe docs/wca.md)
create schema if not exists wca;

-- Ein Import = eine hochgeladene Tempo-Datei. Bleibt auch stehen, wenn neuere Dateien alle seine Buchungstage ersetzt haben.
create table wca.import (
  id             uuid primary key default gen_random_uuid(),
  datei          text not null,
  geaendert      timestamptz,                         -- Änderungsdatum der Datei (lastModified), wenn bekannt
  von            date,                                -- erste Tagesspalte der Datei
  bis            date,                                -- letzte Tagesspalte der Datei
  importiert_am  timestamptz not null default now(),
  importiert_von text
);
create index on wca.import (importiert_am);
select core.enable_audit('wca.import', 'WCA_IMPORT', 'id', '', 'importiert_am');

-- Rückmeldungen (Blattzeilen des Exports); je Person und Datum gilt nur die zuletzt importierte Datei (der Import ersetzt)
create table wca.eintrag (
  id          uuid primary key default gen_random_uuid(),
  import_id   uuid not null references wca.import(id) on delete cascade,
  zeile       integer not null,                       -- Zeilennummer in der Datei (1 = Kopf)
  person      text not null,
  kat         text not null default '',               -- Kategorietyp
  proj        text not null default '',               -- Projektname
  acc         text not null default '',               -- Account roh („Name|Kunde“)
  team        text not null default '',
  ber         text not null default '',               -- Bereich (Jira-Projekt)
  schluessel  text not null default '',               -- Vorgangsschlüssel, z. B. WDEINT001-37
  text        text not null default ''                -- Zeitnachweis (Worklog-Text)
);
create index on wca.eintrag (import_id);
create index on wca.eintrag (person);

-- Stunden je Rückmeldung und Tag (nur Werte ungleich 0)
create table wca.eintrag_tag (
  eintrag_id  uuid not null references wca.eintrag(id) on delete cascade,
  tag         date not null,
  stunden     numeric(8,2) not null,
  primary key (eintrag_id, tag)
);
create index on wca.eintrag_tag (tag);

-- Gelernte Schlüssel aus den Zwischensummen-Zeilen: Account roh → Tempo-Account-Schlüssel, Bereich → Jira-Projektschlüssel
create table wca.schluessel (
  art         text not null check (art in ('acc', 'ber')),
  name        text not null,
  schluessel  text not null,
  primary key (art, name)
);

-- Prüfregeln und Schwellen (eine Zeile; fehlende Felder ergänzt der Server mit den Standardwerten)
create table wca.einstellungen (
  id          integer primary key default 1 check (id = 1),
  daten       jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);
insert into wca.einstellungen (id) values (1);
create trigger einstellungen_touch before update on wca.einstellungen for each row execute function core.touch_updated_at();
select core.enable_audit('wca.einstellungen', 'WCA_EINST', 'id', '', 'updated_at');

-- Vorgaben je Person (null = aus den Buchungen abgeleitet)
create table wca.person (
  person      text primary key,
  standort    text,
  soll_tag    numeric(5,2) check (soll_tag is null or soll_tag between 0 and 24),
  arbeitstage integer[],                              -- 0 = Mo … 6 = So
  von         date,
  bis         date,
  ausblenden  boolean not null default false,
  updated_at  timestamptz not null default now(),
  check (von is null or bis is null or bis >= von)
);
create trigger person_touch before update on wca.person for each row execute function core.touch_updated_at();
select core.enable_audit('wca.person', 'WCA_PERSON', 'person', '', 'updated_at');
