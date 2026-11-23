-- Vorstandssitzungen: Protokolle mit Tagesordnung, Beschlüssen, Aufgaben und Anlagen.
-- Teilnehmer sind die Mitglieder der Mitgliedergruppe „Vorstand“ (samt Untergruppen; Einstellung vs_cfg) plus Gäste.
-- Eine Sitzung kann mit einer Veranstaltung des Vereinskalenders verknüpft sein: Datum, Uhrzeit, Ort sowie Zu- und Absagen
-- kommen dann von dort. Alte Protokolle lassen sich als Markdown-Dateien übernehmen (importiert = true, Quelltext als Anlage).
create table if not exists tco.vs_cfg (
  id        int primary key default 1 check (id = 1),
  gruppe_id int references tco.kal_gruppen(id) on delete set null    -- leer = Gruppe mit dem Namen „Vorstand“
);
insert into tco.vs_cfg (id) values (1) on conflict do nothing;
select core.enable_audit('tco.vs_cfg', 'VS_CFG', 'id');

create table if not exists tco.vs_sitzungen (
  id              serial primary key,
  jahr            int  not null,
  lfd             int  not null,                                  -- Nummer im Jahr: VS <jahr>/<lfd>
  titel           text not null,
  art             text not null default 'VORSTAND' check (art in ('VORSTAND', 'ERWEITERT')),
  datum           date not null,
  beginn          time,
  ende            time,
  ort             text,
  event_id        int references tco.kal_events(id) on delete set null,
  status          text not null default 'GEPLANT' check (status in ('GEPLANT', 'LAEUFT', 'ENTWURF', 'FREIGEGEBEN')),
  leitung         text,
  protokoll_von   text,
  bemerkung       text,                                           -- Vorbemerkung vor der Tagesordnung
  importiert      boolean not null default false,
  freigegeben_am  timestamptz,
  freigegeben_von text,
  erstellt_am     timestamptz not null default now(),
  erstellt_von    text,
  geaendert_am    timestamptz not null default now(),
  geaendert_von   text,
  unique (jahr, lfd)
);
create index if not exists vs_sitzungen_datum_idx on tco.vs_sitzungen (datum desc, id desc);
create index if not exists vs_sitzungen_event_idx on tco.vs_sitzungen (event_id);
select core.enable_audit('tco.vs_sitzungen', 'VS_SITZUNG', 'id', '', 'geaendert_am,geaendert_von');

-- Teilnehmer: Vorstandsmitglieder (adrnr) und Gäste (nur Name)
create table if not exists tco.vs_teilnehmer (
  id         serial primary key,
  sitzung_id int  not null references tco.vs_sitzungen(id) on delete cascade,
  adrnr      text,
  name       text not null,
  rolle      text,
  art        text not null default 'VORSTAND' check (art in ('VORSTAND', 'GAST')),
  status     text not null default 'OFFEN' check (status in ('OFFEN', 'ANWESEND', 'ENTSCHULDIGT', 'FEHLT'))
);
create unique index if not exists vs_teilnehmer_adrnr_uq on tco.vs_teilnehmer (sitzung_id, adrnr) where adrnr is not null;
create index if not exists vs_teilnehmer_idx on tco.vs_teilnehmer (sitzung_id, id);
select core.enable_audit('tco.vs_teilnehmer', 'VS_SITZUNG', 'sitzung_id,id');

-- Tagesordnungspunkte mit Protokolltext
create table if not exists tco.vs_tops (
  id             serial primary key,
  sitzung_id     int  not null references tco.vs_sitzungen(id) on delete cascade,
  pos            int  not null default 0,
  titel          text not null,
  verantwortlich text,
  text           text,
  status         text not null default 'OFFEN' check (status in ('OFFEN', 'ERLEDIGT', 'VERTAGT'))
);
create index if not exists vs_tops_idx on tco.vs_tops (sitzung_id, pos, id);
select core.enable_audit('tco.vs_tops', 'VS_SITZUNG', 'sitzung_id,id');

-- Einträge eines Tagesordnungspunkts: Beschluss (mit Nummer und Abstimmung), Aufgabe (wer, bis wann, erledigt) oder Info
create table if not exists tco.vs_eintraege (
  id             serial primary key,
  top_id         int  not null references tco.vs_tops(id) on delete cascade,
  pos            int  not null default 0,
  art            text not null check (art in ('BESCHLUSS', 'AUFGABE', 'INFO')),
  text           text not null,
  -- Beschluss
  nr_jahr        int,
  nr_lfd         int,
  ja             int check (ja is null or ja >= 0),
  nein           int check (nein is null or nein >= 0),
  enthaltung     int check (enthaltung is null or enthaltung >= 0),
  ergebnis       text check (ergebnis is null or ergebnis in ('ANGENOMMEN', 'ABGELEHNT')),
  -- Aufgabe
  verantwortlich text,
  faellig        date,
  erledigt_am    timestamptz,
  erledigt_von   text,
  check ((art = 'BESCHLUSS') = (nr_jahr is not null and nr_lfd is not null))
);
create unique index if not exists vs_eintraege_nr_uq on tco.vs_eintraege (nr_jahr, nr_lfd) where nr_jahr is not null;
create index if not exists vs_eintraege_idx on tco.vs_eintraege (top_id, pos, id);
create index if not exists vs_eintraege_offen_idx on tco.vs_eintraege (faellig) where art = 'AUFGABE' and erledigt_am is null;
select core.enable_audit('tco.vs_eintraege', 'VS_SITZUNG', 'top_id,id');

-- Anlagen zur Sitzung oder zu einem Tagesordnungspunkt
create table if not exists tco.vs_anlagen (
  id          serial primary key,
  sitzung_id  int  not null references tco.vs_sitzungen(id) on delete cascade,
  top_id      int  references tco.vs_tops(id) on delete set null,
  dateiname   text not null,
  mime        text not null,
  groesse     int  not null,
  inhalt      bytea not null,
  erstellt_am timestamptz not null default now(),
  erstellt_von text
);
create index if not exists vs_anlagen_idx on tco.vs_anlagen (sitzung_id, id);
