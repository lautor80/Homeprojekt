-- Teilnehmer Jugendtraining: feste Trainingstage und Uhrzeiten je Saison (Sommer/Winter eines Jahres).
-- Saison „WINTER“ mit jahr = 2026 ist der Winter 2026/27 (Beginn im Herbst des Jahres).
create table if not exists tco.tn_trainingszeit (
  id         serial primary key,
  adrnr      text     not null,                                  -- tco.mitglieder.adrnr (ohne FK, wie die übrigen Jugend-Tabellen)
  jahr       smallint not null check (jahr between 2000 and 2100),
  saison     text     not null check (saison in ('SOMMER', 'WINTER')),
  wochentag  smallint not null check (wochentag between 1 and 7),   -- 1 = Montag … 7 = Sonntag
  von        time     not null,
  bis        time     not null,
  bemerkung  text     not null default '',
  updated_at timestamptz not null default now(),
  check (bis > von),
  unique (adrnr, jahr, saison, wochentag, von)
);
create index if not exists tn_trainingszeit_saison on tco.tn_trainingszeit (jahr, saison);
create trigger tn_trainingszeit_touch before update on tco.tn_trainingszeit for each row execute function core.touch_updated_at();
select core.enable_audit('tco.tn_trainingszeit', 'TEILNEHMER', 'adrnr');
