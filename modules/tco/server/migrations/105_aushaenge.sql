-- Hinweise in der Hallenbuchung („Aushang“): Mitteilungen mit Bildern, die beim Aufruf von „Platz buchen“ erscheinen –
-- z. B. zur Hallenverschmutzung. Gepflegt in der Platzverwaltung (Reiter „Aushang“, Recht tco.platz:aushang).
create table if not exists tco.aushaenge (
  id           serial primary key,
  titel        text not null default '',
  text         text not null default '',
  stil         text not null default 'INFO' check (stil in ('INFO', 'WARNUNG', 'KRITISCH')),
  gueltig_von  date not null default current_date,
  gueltig_bis  date,                                  -- leer = unbefristet
  rollen       text[] not null default '{}',          -- nur für Benutzer dieser Rollen; leer = alle, die buchen dürfen
  anzeige      text not null default 'EINMAL' check (anzeige in ('EINMAL', 'IMMER')),  -- einmal je Benutzer bzw. bei jedem Aufruf
  bestaetigen  boolean not null default false,        -- „Zur Kenntnis genommen“ ist Pflicht
  aktiv        boolean not null default true,
  erstellt_am  timestamptz not null default now(),
  erstellt_von text,
  geaendert_am timestamptz not null default now(),
  geaendert_von text
);
select core.enable_audit('tco.aushaenge', 'AUSHANG', 'id', '', 'geaendert_am,geaendert_von');

create table if not exists tco.aushang_bilder (
  id         serial primary key,
  aushang_id int not null references tco.aushaenge(id) on delete cascade,
  dateiname  text not null,
  mime       text not null,
  groesse    int not null,
  inhalt     bytea not null
);
create index if not exists aushang_bilder_idx on tco.aushang_bilder (aushang_id, id);

-- Wer welchen Hinweis gesehen bzw. bestätigt hat (Nachweis, z. B. „war informiert“)
create table if not exists tco.aushang_gesehen (
  aushang_id    int not null references tco.aushaenge(id) on delete cascade,
  user_id       uuid not null references core.users(id) on delete cascade,
  gesehen_am    timestamptz not null default now(),
  bestaetigt_am timestamptz,
  primary key (aushang_id, user_id)
);
