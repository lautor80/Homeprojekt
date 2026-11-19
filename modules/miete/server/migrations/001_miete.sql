-- Vermietung: Mieteinnahmen (Kaltmiete / Nebenkosten-Abschlag), laufende Kosten, Zähler und Nebenkostenabrechnung
create schema if not exists miete;

-- Das Haus (ein Objekt je Installation): Anschrift, Vermieter, Paperless-Schlagwort für neue Belege
create table miete.objekt (
  id                 integer primary key default 1 check (id = 1),
  bezeichnung        text not null default 'Mein Haus',
  strasse            text,
  plz                text,
  ort                text,
  vermieter          text,
  vermieter_anschrift text,
  iban               text,
  paperless_tag      text not null default 'Nebenkosten',
  updated_at         timestamptz not null default now()
);
insert into miete.objekt (id) values (1);
create trigger objekt_touch before update on miete.objekt for each row execute function core.touch_updated_at();
select core.enable_audit('miete.objekt', 'MIETOBJEKT', 'id', '', 'updated_at');

-- Wohnungen/Parteien; Eigennutzung = der Vermieter wohnt selbst darin (sein Anteil wird nicht abgerechnet)
create table miete.einheiten (
  id           serial primary key,
  kuerzel      text not null unique,
  bezeichnung  text not null,
  flaeche      numeric(8,2) not null default 0 check (flaeche >= 0),
  personen     numeric(4,1) not null default 0 check (personen >= 0),
  eigennutzung boolean not null default false,
  sort         integer not null default 0
);
select core.enable_audit('miete.einheiten', 'MIETEINHEIT', 'kuerzel');

-- Mietverhältnisse (Mieter einer Einheit für einen Zeitraum)
create table miete.vertraege (
  id          serial primary key,
  nummer      text not null unique,             -- MV0001 aus Nummernkreis MIETVERTRAG
  einheit_id  integer not null references miete.einheiten(id),
  name        text not null,
  email       text,
  telefon     text,
  anschrift   text,                             -- Postanschrift für die Abrechnung, wenn abweichend
  beginn      date not null,
  ende        date,
  personen    numeric(4,1) not null default 1 check (personen >= 0),
  notiz       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  check (ende is null or ende >= beginn)
);
create trigger vertraege_touch before update on miete.vertraege for each row execute function core.touch_updated_at();
select core.enable_audit('miete.vertraege', 'MIETVERTRAG', 'id');

-- Miethöhe ab Stichtag (Mieterhöhung, Anpassung des Abschlags nach der Abrechnung)
create table miete.konditionen (
  id           serial primary key,
  vertrag_id   integer not null references miete.vertraege(id) on delete cascade,
  gueltig_ab   date not null,
  kaltmiete    numeric(10,2) not null check (kaltmiete >= 0),
  nk_abschlag  numeric(10,2) not null check (nk_abschlag >= 0),
  unique (vertrag_id, gueltig_ab)
);
select core.enable_audit('miete.konditionen', 'MIETVERTRAG', 'vertrag_id');

-- Mieteingänge: je Leistungsmonat aufgeteilt in Kaltmiete und Nebenkosten-Abschlag
create table miete.zahlungen (
  id           serial primary key,
  vertrag_id   integer not null references miete.vertraege(id),
  datum        date not null,
  monat        date not null check (extract(day from monat) = 1),
  betrag       numeric(10,2) not null,
  anteil_miete numeric(10,2) not null,
  anteil_nk    numeric(10,2) not null,
  notiz        text,
  created_at   timestamptz not null default now(),
  check (anteil_miete + anteil_nk = betrag)
);
create index on miete.zahlungen (monat);
select core.enable_audit('miete.zahlungen', 'MIETZAHLUNG', 'id', '', 'created_at');

-- Zähler: Hauptzähler (ohne Einheit, z. B. Heizstrom/Hausstrom des Versorgers) und Unterzähler je Einheit
create table miete.zaehler (
  id           serial primary key,
  bezeichnung  text not null,
  nummer       text,
  art          text not null default 'strom' check (art in ('strom', 'waerme', 'wasser', 'gas', 'sonstig')),
  masseinheit  text not null default 'kWh',
  einheit_id   integer references miete.einheiten(id),
  haupt_id     integer references miete.zaehler(id),
  aktiv        boolean not null default true,
  check (haupt_id is null or haupt_id <> id)
);
select core.enable_audit('miete.zaehler', 'ZAEHLER', 'id');

create table miete.ablesungen (
  id          serial primary key,
  zaehler_id  integer not null references miete.zaehler(id) on delete cascade,
  datum       date not null,
  stand       numeric(14,3) not null,
  notiz       text,
  unique (zaehler_id, datum)
);
select core.enable_audit('miete.ablesungen', 'ZAEHLER', 'zaehler_id');

-- Kostenarten mit Verteilerschlüssel (BetrKV § 2); nicht umlagefähige Kosten zählen nur in der Monatsübersicht
create table miete.kostenarten (
  id           serial primary key,
  bezeichnung  text not null unique,
  umlagefaehig boolean not null default true,
  schluessel   text not null default 'flaeche' check (schluessel in ('flaeche', 'personen', 'einheiten', 'anteil', 'verbrauch', 'direkt')),
  zaehler_id   integer references miete.zaehler(id),
  grundanteil  numeric(5,2) not null default 0 check (grundanteil between 0 and 100),
  rest_einheit_id integer references miete.einheiten(id),  -- Differenzmessung: Hauptzähler minus Unterzähler gehört dieser Wohnung (sonst Gemeinschaft nach Fläche)
  anteile      jsonb not null default '{}'::jsonb,   -- Prozent je Einheit (Schlüssel „anteil“): {"<einheit_id>": 50}
  p35a         boolean not null default false,        -- haushaltsnahe Dienstleistung (§ 35a EStG) in der Abrechnung ausweisen
  sort         integer not null default 0,
  aktiv        boolean not null default true
);
select core.enable_audit('miete.kostenarten', 'KOSTENART', 'bezeichnung');

insert into miete.kostenarten (bezeichnung, umlagefaehig, schluessel, p35a, sort) values
  ('Grundsteuer', true, 'flaeche', false, 10),
  ('Wasser/Abwasser', true, 'personen', false, 20),
  ('Heizstrom', true, 'verbrauch', false, 30),
  ('Haushaltsstrom (gemeinsam)', true, 'verbrauch', false, 40),
  ('Müllabfuhr', true, 'personen', false, 50),
  ('Straßenreinigung/Winterdienst', true, 'flaeche', true, 60),
  ('Gebäudeversicherung', true, 'flaeche', false, 70),
  ('Haftpflichtversicherung', true, 'flaeche', false, 80),
  ('Schornsteinfeger', true, 'einheiten', true, 90),
  ('Gartenpflege', true, 'flaeche', true, 100),
  ('Wartung Heizung/Wärmepumpe', true, 'flaeche', true, 110),
  ('Reparaturen/Instandhaltung', false, 'flaeche', false, 200),
  ('Darlehenszinsen', false, 'flaeche', false, 210),
  ('Verwaltung/Bankgebühren', false, 'flaeche', false, 220);

-- laufende Kosten (Rechnungen, Bescheide, Abschläge an Versorger) mit Leistungszeitraum und Beleg in Paperless
create table miete.kosten (
  id           serial primary key,
  kostenart_id integer not null references miete.kostenarten(id),
  datum        date not null,
  von          date,
  bis          date,
  betrag       numeric(10,2) not null,
  lieferant    text,
  belegnr      text,
  einheit_id   integer references miete.einheiten(id),
  paperless_id integer,
  notiz        text,
  created_at   timestamptz not null default now(),
  check ((von is null) = (bis is null) and (bis is null or bis >= von))
);
create index on miete.kosten (datum);
create index on miete.kosten (paperless_id);
select core.enable_audit('miete.kosten', 'MIETKOSTEN', 'id', '', 'created_at');

-- festgeschriebene Nebenkostenabrechnungen (Stand zum Zeitpunkt der Erstellung)
create table miete.abrechnungen (
  id              serial primary key,
  jahr            integer not null,
  vertrag_id      integer not null references miete.vertraege(id),
  von             date not null,
  bis             date not null,
  kosten          numeric(10,2) not null,
  vorauszahlungen numeric(10,2) not null,
  ergebnis        numeric(10,2) not null,
  daten           jsonb not null,
  erstellt_von    text,
  erstellt_am     timestamptz not null default now(),
  versendet_am    date,
  paperless_id    integer,
  unique (jahr, vertrag_id)
);
select core.enable_audit('miete.abrechnungen', 'NKABRECHNUNG', 'jahr,vertrag_id', '', 'daten,erstellt_am');
