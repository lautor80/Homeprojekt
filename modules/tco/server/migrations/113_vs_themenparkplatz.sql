-- Vorstandssitzungen: Themenparkplatz – Themen sammeln, beschreiben, priorisieren und für einen Zeitraum vormerken.
-- Der Stand ergibt sich aus der Zuordnung: ohne Tagesordnungspunkt (oder dieser vertagt) = geparkt, Punkt offen = eingeplant,
-- Punkt erledigt = besprochen; abgeschlossen_am = ohne Sitzung erledigt bzw. zurückgezogen.
create table if not exists tco.vs_themen (
  id                 serial primary key,
  titel              text not null,
  beschreibung       text,
  prioritaet         smallint not null default 2 check (prioritaet between 1 and 3),  -- 1 hoch, 2 mittel, 3 niedrig
  einreicher         text not null,                                                   -- verantwortlich für das Thema
  einreicher_user    uuid references core.users(id) on delete set null,
  von                date not null,
  bis                date not null,
  top_id             int references tco.vs_tops(id) on delete set null,
  zuletzt_sitzung_id int references tco.vs_sitzungen(id) on delete set null,          -- zuletzt zugeordnet (z. B. wieder geparkt)
  abgeschlossen_am   timestamptz,
  abgeschlossen_von  text,
  abschluss_grund    text,
  erstellt_am        timestamptz not null default now(),
  erstellt_von       text,
  geaendert_am       timestamptz not null default now(),
  geaendert_von      text,
  constraint vs_themen_zeitraum check (bis >= von)
);
create unique index if not exists vs_themen_top_uq on tco.vs_themen (top_id) where top_id is not null;
create index if not exists vs_themen_zeitraum_idx on tco.vs_themen (von, bis) where abgeschlossen_am is null;
select core.enable_audit('tco.vs_themen', 'VS_THEMA', 'id');

-- Anlagen eines Themas (Datei oder Verknüpfung); beim Zuordnen werden sie als Anlagen des Tagesordnungspunkts kopiert
create table if not exists tco.vs_themen_anlagen (
  id          serial primary key,
  thema_id    int  not null references tco.vs_themen(id) on delete cascade,
  dateiname   text not null,
  mime        text not null,
  groesse     int  not null,
  inhalt      bytea,
  url         text,
  erstellt_am timestamptz not null default now(),
  erstellt_von text,
  constraint vs_themen_anlagen_datei_oder_link check ((url is null) <> (inhalt is null)),
  constraint vs_themen_anlagen_url_chk check (url is null or url ~* '^https?://')
);
create index if not exists vs_themen_anlagen_idx on tco.vs_themen_anlagen (thema_id, id);
