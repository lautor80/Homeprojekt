-- ---------------------------------------------------------------------------
-- FI-Belege: unveränderlich, Korrektur nur per Storno (Gegenbuchung)
-- ---------------------------------------------------------------------------

alter table tco.fibuchungen
  add column storno_zu  text,                       -- Stornobuchung: interne Nummer der Ursprungsbuchung
  add column erfasst_am timestamptz default now(),
  add column erfasst_von text;

-- je Ursprungsbuchung höchstens ein Storno
create unique index fibuchungen_storno_idx on tco.fibuchungen (storno_zu, konto, posnr) where storno_zu is not null;
create index fibuchungen_datum_idx on tco.fibuchungen (datum);
create index fibuchungen_gkonto_idx on tco.fibuchungen (gkonto, datum);
create index fipapermap_doknr_idx on tco.fipapermap (doknr);

-- Buchungen dürfen nicht geändert oder gelöscht werden.
-- Erlaubt sind nur die Verknüpfungsfelder (Hallenrechnung, Anhang-Kennzeichen)
-- sowie die Übernahme aus SAP (app.action = SAP_IMPORT).
create or replace function tco.fibuchungen_schutz() returns trigger
language plpgsql as $$
begin
  if coalesce(current_setting('app.action', true), '') = 'SAP_IMPORT' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'FI-Belege können nicht gelöscht werden – bitte stornieren (Beleg %).', old.internenr
      using errcode = 'P0001';
  end if;
  if (new.internenr, new.konto, new.posnr, new.jahr, new.monat, new.datum, new.text, new.betrag, new.belnr,
      new.gkonto, new.soll, new.haben, new.storno_zu, new.erfasst_am, new.erfasst_von)
     is distinct from
     (old.internenr, old.konto, old.posnr, old.jahr, old.monat, old.datum, old.text, old.betrag, old.belnr,
      old.gkonto, old.soll, old.haben, old.storno_zu, old.erfasst_am, old.erfasst_von) then
    raise exception 'FI-Belege können nicht geändert werden – bitte stornieren und neu buchen (Beleg %).', old.internenr
      using errcode = 'P0001';
  end if;
  return new;
end $$;

create trigger fibuchungen_schutz before update or delete on tco.fibuchungen
  for each row execute function tco.fibuchungen_schutz();

-- Notizen zur Buchung im Änderungsbeleg
select core.enable_audit('tco.finotiz', 'FIBELEG', 'internenr', '', 'notiz_id,erstellt_am');

-- Einstellungen FI Belege (bisher fest im ABAP-Code)
alter table tco.verein
  add column fi_bankkonten     text not null default '1200,654',          -- Konten mit Bankdatei (CSV-Umsatzexport)
  add column fi_manuell_konten text not null default '1000,1210,1220',    -- Kasse und Konten ohne Bankdatei
  add column fi_beleg_typen    text not null default 'Eingangsrechnung,Hallenrechnung,Abrechnung Jugendtraining',
  add column fi_beleg_pfad     text not null default 'Buchhaltung',
  add column fi_feld_beleg     text not null default '1',   -- Paperless Custom Field: interne Belegnummer
  add column fi_feld_betrag    text not null default '3',   -- Paperless Custom Field: Betrag
  add column fi_feld_sap       text not null default '4';   -- Paperless Custom Field: „SAP“ (zugeordnet ja/nein)

-- IBAN je Geldkonto: Bankdateien werden gegen das gewählte FI-Konto geprüft
create table tco.fibankiban (
  konto text primary key, iban text not null, bezeichnung text, geaendert_am timestamptz default now()
);
select core.enable_audit('tco.fibankiban', 'FIKONTO', 'konto', '', 'geaendert_am');
