-- Haushaltsplan: Projekte mit Planung, Genehmigung und Simulation (docs/haushaltsplan/konzept.md, Abschnitt 10).
-- Ein Projekt hat eine Zeitspanne (Monate, auch über mehrere Geschäftsjahre) und Positionen (Kosten, Finanzierung,
-- Folgekosten). Die Ist-Kosten kommen aus den FI-Buchungen mit derselben Projektnummer (tco.fibuchungen.projekt,
-- Stamm tco.projekte) – FI wird dafür nur gelesen.

create table if not exists tco.hh_projekt (
  id            serial primary key,
  projektnr     text unique,                 -- Projektnummer der FI-Buchungen (tco.fibuchungen.projekt); leer = noch keine
  bezeichnung   text not null check (trim(bezeichnung) <> ''),
  beschreibung  text,
  verantwortlich text,
  beginn        date not null,               -- Monatserster
  ende          date not null check (ende >= beginn),
  bereich       text check (bereich in ('A', 'B', 'C', 'D')),
  status        text not null default 'IDEE'
                check (status in ('IDEE', 'BEANTRAGT', 'GENEHMIGT', 'ABGELEHNT', 'ZURUECKGESTELLT', 'UMSETZUNG', 'ABGESCHLOSSEN')),
  status_am     timestamptz not null default now(),
  status_von    text,
  status_grund  text,
  angelegt_am   timestamptz not null default now(),
  angelegt_von  text
);
select core.enable_audit('tco.hh_projekt', 'HH_PROJEKT', 'id', '', 'angelegt_am,status_am');

create table if not exists tco.hh_projekt_position (
  id          serial primary key,
  projekt_id  int not null references tco.hh_projekt (id) on delete cascade,
  art         text not null check (art in ('KOSTEN', 'ZUSCHUSS', 'SPENDE', 'EIGENMITTEL', 'DARLEHEN', 'TILGUNG', 'FOLGEKOSTEN', 'EINSPARUNG')),
  bezeichnung text,
  betrag      numeric(15,2) not null default 0 check (betrag >= 0),
  konto       text,
  verteilung  text not null default 'GLEICH' check (verteilung in ('GLEICH', 'MONAT', 'HAND', 'JAEHRLICH')),
  von         date,                          -- eigener Zeitraum der Position; leer = Laufzeit des Projekts
  bis         date,
  monate      jsonb not null default '{}'    -- Verteilung von Hand: {"JJJJ-MM": Betrag}
);
create index if not exists hh_projekt_position_projekt on tco.hh_projekt_position (projekt_id);
select core.enable_audit('tco.hh_projekt_position', 'HH_PROJEKT', 'projekt_id');

-- Verlauf der Genehmigung: wer hat wann welchen Status gesetzt, mit Begründung
create table if not exists tco.hh_projekt_verlauf (
  id          serial primary key,
  projekt_id  int not null references tco.hh_projekt (id) on delete cascade,
  am          timestamptz not null default now(),
  von         text not null,
  status      text not null,
  grund       text
);
create index if not exists hh_projekt_verlauf_projekt on tco.hh_projekt_verlauf (projekt_id, am);

-- Simulation je Plan-Fassung: Projekt einrechnen ja/nein (kein Eintrag = Vorgabe nach dem Status des Projekts).
-- Mit dem Beschluss des Plans wird festgeschrieben, welche Projekte mit welchen Werten eingerechnet waren (fest).
create table if not exists tco.hh_plan_projekt (
  plan_id    int not null references tco.hh_plan (id) on delete cascade,
  projekt_id int not null references tco.hh_projekt (id) on delete cascade,
  einrechnen boolean not null,
  fest       jsonb,
  primary key (plan_id, projekt_id)
);
select core.enable_audit('tco.hh_plan_projekt', 'HH_PLAN', 'plan_id', '', 'fest');

drop trigger if exists hh_schutz on tco.hh_plan_projekt;
create trigger hh_schutz before insert or update or delete on tco.hh_plan_projekt for each row execute function tco.hh_schutz();
