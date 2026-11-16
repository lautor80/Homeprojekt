-- Haushaltsplan (docs/haushaltsplan/konzept.md): Budget je Konto mit Vorschlag aus den Vorjahren, Fassungen mit Status,
-- Monatsverteilung, einmalige Vorhaben, Sondereffekte und Vorgängerkonten. Der Haushaltsplan liest FI nur.

-- Einstellungen (Administration → Einstellungen → TC Oberthal → Haushaltsplan)
create table if not exists tco.hh_cfg (
  id                 int primary key default 1 check (id = 1),
  toleranz_gelb      numeric(6,2) not null default 5   check (toleranz_gelb >= 0),     -- ab hier „beobachten“ (%)
  toleranz_rot       numeric(6,2) not null default 10  check (toleranz_rot >= 0),      -- ab hier „überschritten“ (%)
  mindestreserve     numeric(15,2),                                                   -- leer = keine Bewertung der Liquidität
  ausreisser_prozent numeric(6,2) not null default 50  check (ausreisser_prozent > 0), -- Abweichung vom Median, ab der ein Jahr als Sondereffekt vorgeschlagen wird
  grundlage_ab       int check (grundlage_ab between 1990 and 2100),                   -- leer = alle vorhandenen Jahre (höchstens die letzten 6)
  preissteigerung    numeric(5,2) not null default 0   check (preissteigerung between -50 and 100), -- Vorgabe für neue Pläne (% auf Ausgaben)
  genehmigung_mv     boolean not null default true                                     -- Schritt „von der Mitgliederversammlung genehmigt“ anbieten
);
insert into tco.hh_cfg (id) values (1) on conflict do nothing;
select core.enable_audit('tco.hh_cfg', 'HH_CFG', 'id');

-- Plan je Geschäftsjahr und Fassung; ab „beschlossen“ unveränderlich, Änderungen nur als Nachtrag (neue Fassung)
create table if not exists tco.hh_plan (
  id              serial primary key,
  jahr            int not null check (jahr between 1990 and 2100),
  fassung         int not null default 1 check (fassung >= 1),
  status          text not null default 'ENTWURF' check (status in ('ENTWURF', 'BESCHLOSSEN', 'GENEHMIGT')),
  begruendung     text,                      -- Nachtrag: warum die neue Fassung
  beschlossen_am  date,
  beschlossen_von text,
  genehmigt_am    date,
  genehmigt_von   text,
  preissteigerung numeric(5,2) not null default 0,   -- % auf Ausgaben (je Konto übersteuerbar)
  mindestreserve  numeric(15,2),                     -- leer = Wert der Einstellungen
  tilgung         numeric(15,2),                     -- Tilgung im Planjahr; leer = aus den Darlehenskonten (Kennzahl BK) abgeleitet
  anfangsbestand  numeric(15,2),                     -- Geldbestand zum 01.01.; leer = berechnet
  stand           date,                              -- Datenstand, mit dem der Vorschlag zuletzt berechnet wurde
  notiz           text,
  paperless_id    int,
  angelegt_am     timestamptz not null default now(),
  angelegt_von    text,
  unique (jahr, fassung)
);
select core.enable_audit('tco.hh_plan', 'HH_PLAN', 'id', '', 'angelegt_am,paperless_id');

create table if not exists tco.hh_position (
  plan_id   int not null references tco.hh_plan (id) on delete cascade,
  konto     text not null,
  methode   text not null check (methode in ('HOCH', 'AVG3', 'MED5', 'TREND', 'FACH', 'MANUELL')),
  vorschlag numeric(15,2),                 -- Wert der Methode ohne Preissteigerung; leer = Methode liefert nichts
  planwert  numeric(15,2) not null default 0,
  zuschlag  numeric(5,2),                  -- Preissteigerung dieses Kontos in %; leer = Wert des Plans
  notiz     text,
  manuell   boolean not null default false, -- Planwert von Hand geändert
  primary key (plan_id, konto)
);
select core.enable_audit('tco.hh_position', 'HH_PLAN', 'plan_id');

-- Monatswerte eines Kontos: von Hand geändert oder – beim Beschluss – der berechnete Verlauf festgeschrieben
create table if not exists tco.hh_monat (
  plan_id  int not null,
  konto    text not null,
  monat    int not null check (monat between 1 and 12),
  betrag   numeric(15,2) not null default 0,
  von_hand boolean not null default true,
  primary key (plan_id, konto, monat),
  foreign key (plan_id, konto) references tco.hh_position (plan_id, konto) on delete cascade
);
select core.enable_audit('tco.hh_monat', 'HH_PLAN', 'plan_id');

-- Jahre eines Kontos, die nicht in die Grundlage zählen (gilt für alle Pläne)
create table if not exists tco.hh_sondereffekt (
  konto       text not null,
  jahr        int not null check (jahr between 1990 and 2100),
  grund       text not null check (trim(grund) <> ''),
  erfasst_am  timestamptz not null default now(),
  erfasst_von text,
  primary key (konto, jahr)
);
select core.enable_audit('tco.hh_sondereffekt', 'HH_SONDEREFFEKT', 'konto', '', 'erfasst_am');

create table if not exists tco.hh_vorhaben (
  id          serial primary key,
  plan_id     int not null references tco.hh_plan (id) on delete cascade,
  bezeichnung text not null check (trim(bezeichnung) <> ''),
  art         text not null check (art in ('E', 'A')),
  monat       int not null check (monat between 1 and 12),
  betrag      numeric(15,2) not null check (betrag >= 0),
  konto       text,
  projekt     text,
  eingeplant  boolean not null default true
);
create index if not exists hh_vorhaben_plan on tco.hh_vorhaben (plan_id);
select core.enable_audit('tco.hh_vorhaben', 'HH_PLAN', 'plan_id');

-- Vorgängerkonto: Die Jahre vor „ab Jahr“ kommen aus dem Vorgängerkonto
create table if not exists tco.hh_konto_vorgaenger (
  konto      text primary key,
  vorgaenger text not null check (vorgaenger <> konto),
  ab_jahr    int not null check (ab_jahr between 1990 and 2100)
);
select core.enable_audit('tco.hh_konto_vorgaenger', 'HH_SONDEREFFEKT', 'konto');

-- Beschlossene Fassungen sind unveränderlich: Positionen, Monatswerte und Vorhaben lassen sich nur im Entwurf ändern.
-- (Bei einer Rücksicherung sind Trigger aus – session_replication_role = replica.)
create or replace function tco.hh_schutz() returns trigger
language plpgsql as $$
declare
  p int;
  s text;
begin
  if tg_op = 'DELETE' then p := old.plan_id; else p := new.plan_id; end if;
  select status into s from tco.hh_plan where id = p;
  -- s ist leer, wenn der Plan selbst gerade gelöscht wird (Kaskade) – das entscheidet die Anwendung
  if s is not null and s <> 'ENTWURF' then
    raise exception 'Der Haushaltsplan ist beschlossen und kann nicht mehr geändert werden – bitte einen Nachtrag anlegen.'
      using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;

drop trigger if exists hh_schutz on tco.hh_position;
create trigger hh_schutz before insert or update or delete on tco.hh_position for each row execute function tco.hh_schutz();
drop trigger if exists hh_schutz on tco.hh_monat;
create trigger hh_schutz before insert or update or delete on tco.hh_monat for each row execute function tco.hh_schutz();
drop trigger if exists hh_schutz on tco.hh_vorhaben;
create trigger hh_schutz before insert or update or delete on tco.hh_vorhaben for each row execute function tco.hh_schutz();
