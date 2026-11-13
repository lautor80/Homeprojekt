-- Instandhaltung (#205, 2. Nachtrag): Priorität, geplantes und tatsächliches Enddatum, Istkosten, mehrere Paperless-Dokumente
-- je Meldung (Verknüpfung auch zum FI-Beleg über dieselbe Paperless-ID), Listenvarianten je Benutzer (tco.rpt_variant).

alter table tco.ih_meldung add column if not exists prioritaet text not null default 'MITTEL'
  check (prioritaet in ('SEHR_HOCH', 'HOCH', 'MITTEL', 'NIEDRIG'));
alter table tco.ih_meldung add column if not exists geplant_bis date;   -- geplantes Enddatum
alter table tco.ih_meldung add column if not exists ende_ist date;      -- tatsächliches Enddatum
update tco.ih_meldung set prioritaet = case auswirkung when 'SICHERHEIT' then 'SEHR_HOCH' when 'UNBESPIELBAR' then 'HOCH' else 'MITTEL' end;
update tco.ih_meldung set ende_ist = (erledigt_am at time zone 'Europe/Berlin')::date where erledigt_am is not null and ende_ist is null;
comment on column tco.ih_meldung.kosten is 'Istkosten';

-- Paperless-Dokumente (Angebot, Rechnung, Formular …) einer Meldung
create table if not exists tco.ih_dokument (
  meldung_id    int  not null references tco.ih_meldung (id) on delete cascade,
  doc_id        int  not null,
  art           text not null default 'SONSTIGES' check (art in ('ANGEBOT', 'RECHNUNG', 'FORMULAR', 'FOTO', 'SONSTIGES')),
  titel         text not null default '',
  korrespondent text not null default '',
  datum         date,
  am            timestamptz not null default now(),
  von           text not null,
  primary key (meldung_id, doc_id)
);
create index if not exists ih_dokument_doc_idx on tco.ih_dokument (doc_id);
select core.enable_audit('tco.ih_dokument', 'SCHADEN', 'meldung_id', '', 'am');

-- bisherige Freitext-Verweise mit reiner Dokumentnummer übernehmen; abgelegte Formulare ebenfalls
insert into tco.ih_dokument (meldung_id, doc_id, art, von)
select id, paperless::int, 'SONSTIGES', coalesce(geaendert_von, 'Übernahme') from tco.ih_meldung where paperless ~ '^\s*\d{1,9}\s*$'
on conflict do nothing;
update tco.ih_meldung set paperless = null where paperless ~ '^\s*\d{1,9}\s*$';
insert into tco.ih_dokument (meldung_id, doc_id, art, titel, von)
select id, formular_doc_id, 'FORMULAR', 'Schadensmeldung ' || nummer, 'Übernahme' from tco.ih_meldung where formular_doc_id is not null
on conflict do nothing;

-- Auswahl im Dokumentendialog: Paperless-Dokumenttypen und Speicherpfade der Instandhaltung (zusätzlich zu den FI-Belegen)
alter table tco.ih_einstellungen add column if not exists paperless_typen text not null default 'Schadensmeldung, Angebot, Rechnung';
alter table tco.ih_einstellungen add column if not exists paperless_pfade text not null default 'Instandhaltung';
