-- Projekte (App „Projekte“): Termin- und Ressourcenplanung zu den Projekten des Haushaltsplans (tco.hh_projekt).
-- Die Kostenplanung (Positionen, Genehmigung, Simulation im Plan) bleibt, wie sie ist. Neu:
--   Vorgänge mit Dauer und Abhängigkeiten (Gantt), Arbeitseinsatz der Mitglieder mit Stunden und externem
--   Verrechnungssatz, Material mit Menge und Preis, Projektantrag als PDF mit Ablage in Paperless.

-- Vorgabe für den externen Verrechnungssatz (Euro je Stunde): was die Arbeit kostete, wenn eine Firma sie ausführte
alter table tco.hh_projekt add column if not exists stundensatz numeric(10,2) not null default 0 check (stundensatz >= 0);
alter table tco.hh_projekt add column if not exists antrag_paperless_id int;
alter table tco.hh_projekt add column if not exists antrag_paperless_am timestamptz;

-- Vorgang: Dauer in Kalendertagen (0 = Meilenstein). beginn = frühester Beginn von Hand; ohne ihn beginnt der Vorgang
-- nach seinen Vorgängern bzw. mit dem Projekt.
create table if not exists tco.hh_projekt_vorgang (
  id             serial primary key,
  projekt_id     int not null references tco.hh_projekt (id) on delete cascade,
  pos            int not null default 0,
  bezeichnung    text not null check (trim(bezeichnung) <> ''),
  beginn         date,
  dauer          int not null default 1 check (dauer >= 0 and dauer <= 3660),
  fertig         int not null default 0 check (fertig between 0 and 100),
  verantwortlich text,
  notiz          text
);
create index if not exists hh_projekt_vorgang_projekt on tco.hh_projekt_vorgang (projekt_id, pos, id);
select core.enable_audit('tco.hh_projekt_vorgang', 'HH_PROJEKT', 'projekt_id');

-- Abhängigkeit Ende → Anfang: der Vorgang beginnt frühestens `abstand` Tage nach dem Ende des Vorgängers
create table if not exists tco.hh_projekt_vorgang_vor (
  vorgang_id    int not null references tco.hh_projekt_vorgang (id) on delete cascade,
  vorgaenger_id int not null references tco.hh_projekt_vorgang (id) on delete cascade,
  abstand       int not null default 0 check (abstand between -366 and 3660),
  primary key (vorgang_id, vorgaenger_id),
  check (vorgang_id <> vorgaenger_id)
);

-- Arbeitseinsatz: ein Mitglied (adrnr) oder eine freie Angabe („Helfer“), Personen × Stunden je Person.
-- satz = externer Verrechnungssatz dieser Zeile; leer = Vorgabe des Projekts.
create table if not exists tco.hh_projekt_arbeit (
  id          serial primary key,
  projekt_id  int not null references tco.hh_projekt (id) on delete cascade,
  vorgang_id  int references tco.hh_projekt_vorgang (id) on delete set null,
  adrnr       text,
  name        text not null check (trim(name) <> ''),
  taetigkeit  text,
  personen    int not null default 1 check (personen between 1 and 500),
  stunden     numeric(8,2) not null default 0 check (stunden >= 0),
  satz        numeric(10,2) check (satz is null or satz >= 0)
);
create index if not exists hh_projekt_arbeit_projekt on tco.hh_projekt_arbeit (projekt_id, id);
select core.enable_audit('tco.hh_projekt_arbeit', 'HH_PROJEKT', 'projekt_id');

create table if not exists tco.hh_projekt_material (
  id          serial primary key,
  projekt_id  int not null references tco.hh_projekt (id) on delete cascade,
  vorgang_id  int references tco.hh_projekt_vorgang (id) on delete set null,
  bezeichnung text not null check (trim(bezeichnung) <> ''),
  menge       numeric(12,3) not null default 1 check (menge >= 0),
  einheit     text,
  preis       numeric(15,2) not null default 0 check (preis >= 0),   -- Einzelpreis
  lieferant   text,
  beschafft   boolean not null default false
);
create index if not exists hh_projekt_material_projekt on tco.hh_projekt_material (projekt_id, id);
select core.enable_audit('tco.hh_projekt_material', 'HH_PROJEKT', 'projekt_id');
