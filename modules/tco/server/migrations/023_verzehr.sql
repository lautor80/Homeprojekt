-- Clubhaus-Verzehr: Anschreiben auf das Mitgliedskonto, Gastbelege an der Theke, Sammelabrechnung zum Monatsende.
-- Preise kommen aus tco.produkte (Getränke 100–199, Speisen 200–299, Sonstiges 300–399); optionaler Gästepreis.
alter table tco.produkte add column if not exists preis_gast numeric(15,2);

create table if not exists tco.vz_cfg (
  id               int primary key default 1 check (id = 1),
  mindestbetrag    numeric(15,2) not null default 5,      -- darunter Übertrag in den Folgemonat
  zahlungsziel_tage int not null default 14,
  storno_stunden   int not null default 12,              -- Mitglieder: eigenen Eintrag so lange stornieren
  erloeskonto      text not null default '',
  forderungskonto  text not null default '',
  info_text        text not null default ''              -- Hinweis in „Mein Verzehr“
);
insert into tco.vz_cfg (id) values (1) on conflict do nothing;
select core.enable_audit('tco.vz_cfg', 'VZ_CFG', 'id');

-- Belege: Gastbeleg (am Abend kassiert) oder Sammelabrechnung eines Mitglieds (Monat)
create table if not exists tco.vz_belege (
  rgnr         text primary key,                        -- VZG-2026-00001 (Gast) / VZM-2026-11-0001 (Sammel)
  art          text not null check (art in ('GAST', 'SAMMEL')),
  adrnr        text,                                    -- Mitglied (SAMMEL)
  gast_name    text, gast_gruppe text, email text, mobil text,
  datum        date not null default current_date,
  monat        text,                                    -- SAMMEL: JJJJMM
  status       text not null default 'OFFEN' check (status in ('OFFEN', 'GESTELLT', 'BEZAHLT', 'STORNIERT')),
  betrag       numeric(15,2) not null default 0,
  zahlart      text check (zahlart is null or zahlart in ('BAR', 'KARTE', 'PAYPAL', 'UEBERWEISUNG', 'LASTSCHRIFT')),
  faellig      date,
  bezahlt_am   date,
  doc_id       int,
  versand_am   timestamptz, versand_art text,
  laufid       text,                                    -- Sollstellung (Lastschrift)
  erstellt_am  timestamptz not null default now(), erstellt_von text,
  bemerkung    text,
  check (art <> 'SAMMEL' or adrnr is not null)
);
create index if not exists vz_belege_status_idx on tco.vz_belege (status, datum);
create index if not exists vz_belege_adrnr_idx on tco.vz_belege (adrnr, monat);
select core.enable_audit('tco.vz_belege', 'VZ_BELEG', 'rgnr');

-- Einzelne Verzehrpositionen (Preis als Momentaufnahme)
create table if not exists tco.vz_posten (
  id            bigserial primary key,
  datum         date not null default current_date,
  zeit          time not null default localtime(0),
  adrnr         text,                                   -- Mitgliedskonto
  rgnr          text references tco.vz_belege (rgnr),   -- Gastbeleg bzw. Sammelabrechnung
  prod_key      text not null,
  text          text not null,
  anzahl        numeric(9,2) not null check (anzahl > 0),
  preis         numeric(15,2) not null,
  betrag        numeric(15,2) not null,
  selbst        boolean not null default false,         -- vom Mitglied selbst erfasst
  erfasst_von   text, erfasst_benutzer uuid, erfasst_am timestamptz not null default now(),
  storniert_am  timestamptz, storniert_von text, storno_grund text,
  check (adrnr is not null or rgnr is not null)
);
create index if not exists vz_posten_datum_idx on tco.vz_posten (datum);
create index if not exists vz_posten_adrnr_idx on tco.vz_posten (adrnr) where rgnr is null and storniert_am is null;
select core.enable_audit('tco.vz_posten', 'VZ_POSTEN', 'id');
