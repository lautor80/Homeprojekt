-- Vorstandssitzungen: Verknüpfungen (URLs) als Anlage zur Sitzung oder zum Tagesordnungspunkt – neben Dateien.
-- Ein Link hat eine Adresse (url) und eine Bezeichnung (dateiname), aber keinen Inhalt.
alter table tco.vs_anlagen add column if not exists url text;
alter table tco.vs_anlagen alter column inhalt drop not null;
alter table tco.vs_anlagen drop constraint if exists vs_anlagen_datei_oder_link;
alter table tco.vs_anlagen add constraint vs_anlagen_datei_oder_link check ((url is null) <> (inhalt is null));
alter table tco.vs_anlagen drop constraint if exists vs_anlagen_url_chk;
alter table tco.vs_anlagen add constraint vs_anlagen_url_chk check (url is null or url ~* '^https?://');
