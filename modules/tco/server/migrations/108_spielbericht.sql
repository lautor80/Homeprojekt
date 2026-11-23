-- Spielberichte (Sport → Spielberichte): Mannschaftsspieltage und Meldelisten aus STB.LIGA.NU (eingefügte Tabelle),
-- Spielbericht je Spieltag nach dem DTB-Spielbericht mit Freigabe beider Mannschaftsführer statt Unterschrift.

-- Mannschaftsspieltage (Spielplan aus STB.LIGA.NU; gleiche Begegnung wird beim erneuten Import aktualisiert)
create table tco.sb_spieltage (
  id          serial primary key,
  saison      text not null,
  datum       date not null,
  uhrzeit     text check (uhrzeit is null or uhrzeit ~ '^\d{2}:\d{2}$'),
  nr          text not null default '',
  halle       text not null default '',
  platz       text not null default '',
  liga        text not null,
  heim        text not null,
  gast        text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (datum, liga, heim, gast)
);
create index sb_spieltage_saison on tco.sb_spieltage (saison, datum);
create trigger sb_spieltage_touch before update on tco.sb_spieltage for each row execute function core.touch_updated_at();
select core.enable_audit('tco.sb_spieltage', 'SPIELBERICHT', 'id', '', 'created_at,updated_at');

-- Meldelisten je Saison, Verein und Konkurrenz („Herren 40“) – eigene und die der Gegner
create table tco.sb_meldelisten (
  id          serial primary key,
  saison      text not null,
  verein      text not null,
  konkurrenz  text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (saison, verein, konkurrenz)
);
create trigger sb_meldelisten_touch before update on tco.sb_meldelisten for each row execute function core.touch_updated_at();
select core.enable_audit('tco.sb_meldelisten', 'MELDELISTE', 'id', '', 'created_at,updated_at');

create table tco.sb_meldespieler (
  liste_id    integer not null references tco.sb_meldelisten(id) on delete cascade,
  rang        integer not null check (rang between 1 and 999),
  mannschaft  integer check (mannschaft is null or mannschaft between 1 and 99),
  nachname    text not null,
  vorname     text not null default '',
  id_nr       text,
  lk          numeric(3, 1),
  nation      text not null default '',
  primary key (liste_id, rang)
);
select core.enable_audit('tco.sb_meldespieler', 'MELDELISTE', 'liste_id,rang');

-- Spielbericht je Spieltag; Inhalt siehe modules/tco/server/sport/spielbericht-logik.ts (SbDaten)
create table tco.sb_berichte (
  spieltag_id         integer primary key references tco.sb_spieltage(id) on delete restrict,
  daten               jsonb not null,
  status              text not null default 'entwurf' check (status in ('entwurf', 'eingereicht')),
  -- Freigabe statt Unterschrift: Name, Zeitpunkt, Benutzer; eine Änderung am Bericht setzt die Freigaben zurück
  heim_name           text, heim_am timestamptz, heim_von text,
  gast_name           text, gast_am timestamptz, gast_von text,
  osr_name            text, osr_am timestamptz, osr_von text,
  eingereicht_am      timestamptz,
  eingereicht_von     text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create trigger sb_berichte_touch before update on tco.sb_berichte for each row execute function core.touch_updated_at();
select core.enable_audit('tco.sb_berichte', 'SPIELBERICHT', 'spieltag_id', '', 'created_at,updated_at');

-- Rechte: Sportwart darf alles; wer Spielerdaten pflegt, darf auch Spielberichte erfassen und importieren
insert into core.role_permissions (role_id, permission)
select 'SPORTWART', p from (values ('tco.spielbericht:display'), ('tco.spielbericht:edit'), ('tco.spielbericht:import')) as x(p)
 where exists (select 1 from core.roles where id = 'SPORTWART')
on conflict do nothing;
insert into core.role_permissions (role_id, permission)
select distinct role_id, p from core.role_permissions, (values ('tco.spielbericht:display'), ('tco.spielbericht:edit'), ('tco.spielbericht:import')) as x(p)
 where permission = 'tco.sport:edit'
on conflict do nothing;
