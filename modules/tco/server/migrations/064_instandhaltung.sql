-- Instandhaltung / Schadensmeldung (#205): Mitglieder melden Schäden an der Anlage (Plätze, Halle, Clubhaus …),
-- Platzwart/Hallenwart/Vorstand bearbeiten sie. Offene Meldungen stehen im Arbeitsvorrat der Vereinsübersicht.

-- Anlagen: Orte, an denen etwas kaputt sein kann (Platz = Verknüpfung zur Platzbuchung für die Sperrzeit)
create table if not exists tco.ih_anlage (
  id          serial primary key,
  kuerzel     text    not null,                     -- für den QR-Link /tco/schaden?anlage=<kuerzel>
  bezeichnung text    not null,
  typ         text    not null default 'SONSTIGES' check (typ in ('PLATZ', 'HALLE', 'GEBAEUDE', 'AUSSEN', 'SONSTIGES')),
  platz_id    int     references tco.plaetze (id) on delete set null,
  sort        int     not null default 0,
  aktiv       boolean not null default true
);
create unique index if not exists ih_anlage_kuerzel_uq on tco.ih_anlage (lower(kuerzel));

-- Kategorien mit Standard-Zuständigem (Benutzer)
create table if not exists tco.ih_kategorie (
  id          serial primary key,
  bezeichnung text    not null,
  zustaendig  uuid    references core.users (id) on delete set null,
  sort        int     not null default 0,
  aktiv       boolean not null default true
);
create unique index if not exists ih_kategorie_bez_uq on tco.ih_kategorie (lower(bezeichnung));

create table if not exists tco.ih_meldung (
  id           serial primary key,
  nummer       text    not null unique,              -- SM-JJJJ-NNNN
  anlage_id    int     not null references tco.ih_anlage (id),
  kategorie_id int     not null references tco.ih_kategorie (id),
  beschreibung text    not null,
  auswirkung   text    not null check (auswirkung in ('SICHERHEIT', 'UNBESPIELBAR', 'EINGESCHRAENKT', 'OPTISCH')),
  status       text    not null default 'NEU'
               check (status in ('NEU', 'GESICHTET', 'ZUGEWIESEN', 'IN_ARBEIT', 'WARTET', 'ERLEDIGT', 'ABGELEHNT', 'DUPLIKAT')),
  eingang      timestamptz not null default now(),
  melder_id    uuid    references core.users (id) on delete set null,
  melder_name  text    not null,
  zustaendig   uuid    references core.users (id) on delete set null,
  duplikat_von int     references tco.ih_meldung (id) on delete set null,
  erledigung   text,                                 -- was wurde gemacht / Grund der Ablehnung
  kosten       numeric(10, 2),
  firma        text,                                 -- Fremdfirma
  paperless    text,                                 -- Angebot/Rechnung in Paperless (Dokumentnummer oder Link)
  stunden      numeric(6, 2),                        -- geleistete Helferstunden (Arbeitsdienst)
  sperre_id    int     references tco.platzbelegungen (id) on delete set null,
  status_am    timestamptz not null default now(),   -- letzter Statuswechsel (Eskalation)
  erinnert_am  timestamptz,                          -- letzte Erinnerung bei Sicherheitsrisiko
  erledigt_am  timestamptz,
  geaendert_am timestamptz, geaendert_von text
);
create index if not exists ih_meldung_offen_idx on tco.ih_meldung (status, eingang);
create index if not exists ih_meldung_anlage_idx on tco.ih_meldung (anlage_id);

-- Verlauf: Statuswechsel und Kommentare; fuer_melder = in „Meine Meldungen“ sichtbar
create table if not exists tco.ih_verlauf (
  id          serial primary key,
  meldung_id  int     not null references tco.ih_meldung (id) on delete cascade,
  am          timestamptz not null default now(),
  von         text    not null,
  status      text,
  text        text,
  fuer_melder boolean not null default true
);
create index if not exists ih_verlauf_meldung_idx on tco.ih_verlauf (meldung_id, am);

-- Fotos (im Browser verkleinert); werden nach der Frist bei erledigten Meldungen gelöscht
create table if not exists tco.ih_anhang (
  id          serial primary key,
  meldung_id  int     not null references tco.ih_meldung (id) on delete cascade,
  art         text    not null default 'VORHER' check (art in ('VORHER', 'NACHHER')),
  name        text    not null,
  mime        text    not null,
  daten       bytea   not null,
  groesse     int     not null,
  am          timestamptz not null default now(),
  von         text    not null
);
create index if not exists ih_anhang_meldung_idx on tco.ih_anhang (meldung_id);

create table if not exists tco.ih_einstellungen (
  id                int  primary key default 1 check (id = 1),
  vorstand_email    text not null default '',        -- Sicherheitsrisiken und Meldungen ohne Zuständigen (mehrere mit Komma)
  foto_frist_monate int  not null default 24 check (foto_frist_monate between 1 and 120)
);
insert into tco.ih_einstellungen (id) values (1) on conflict do nothing;

-- Vorbelegung: Kategorien und Anlagen (Plätze aus der Platzbuchung, dazu Clubhaus & Co.)
insert into tco.ih_kategorie (bezeichnung, sort)
select x.b, x.s from (values ('Platzbelag/Sand', 10), ('Linien', 20), ('Netz/Pfosten', 30), ('Bewässerung', 40), ('Zaun/Windschutz', 50),
                              ('Flutlicht', 60), ('Hallenboden/-licht', 70), ('Heizung', 80), ('Sanitär', 90), ('Elektrik', 100), ('Sonstiges', 999)) x(b, s)
 where not exists (select 1 from tco.ih_kategorie);
insert into tco.ih_anlage (kuerzel, bezeichnung, typ, platz_id, sort)
select 'platz' || p.id, p.name, case when p.art = 'HALLE' then 'HALLE' else 'PLATZ' end, p.id, p.sort
  from tco.plaetze p
 where p.aktiv and not exists (select 1 from tco.ih_anlage);
insert into tco.ih_anlage (kuerzel, bezeichnung, typ, sort)
select x.k, x.b, x.t, x.s from (values ('clubhaus', 'Clubhaus', 'GEBAEUDE', 900), ('sanitaer', 'Umkleiden/Sanitär', 'GEBAEUDE', 910),
                                       ('aussen', 'Außenanlage/Parkplatz', 'AUSSEN', 920)) x(k, b, t, s)
 where not exists (select 1 from tco.ih_anlage a where a.kuerzel = x.k);

select core.enable_audit('tco.ih_meldung', 'SCHADEN', 'id', '', 'status_am,erinnert_am,geaendert_am,geaendert_von');
select core.enable_audit('tco.ih_anlage', 'IH_ANLAGE', 'id');
select core.enable_audit('tco.ih_kategorie', 'IH_KATEGORIE', 'id');
select core.enable_audit('tco.ih_einstellungen', 'IH_CFG', 'id');

-- Mitglieder dürfen Schäden melden (Rolle „Mitglied“, sofern vorhanden)
insert into core.role_permissions (role_id, permission)
select id, 'tco.schaden:melden' from core.roles where id = 'MITGLIED'
on conflict do nothing;
