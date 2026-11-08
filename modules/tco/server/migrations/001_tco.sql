-- ===========================================================================
-- TC Oberthal – Datenmodell (Port der ZTCO-Tabellen aus SAP)
-- Feldnamen wie in SAP (klein geschrieben), damit die CSV-Exporte von
-- ZTCO_ARCHIVE direkt übernommen werden können. Adressnummern bleiben Text
-- (00… Mitglied, 99… EP3-Kunde).
-- ===========================================================================
create schema tco;

-- ---------------------------------------------------------------------------
-- Vereinsdaten und Anbindungen (bisher Konstanten im ABAP-Code)
-- ---------------------------------------------------------------------------
create table tco.verein (
  id               int primary key default 1 check (id = 1),
  name             text not null default 'Verein',
  strasse          text,
  plz_ort          text,
  iban             text,
  bic              text,
  bank             text,
  steuernr         text,
  ansprechpartner  text,
  email            text,
  zahlungsziel_tage int not null default 8,
  logo             text,                           -- Data-URL; leer = Vereinslogo
  paperless_url    text,                           -- mehrere durch Komma: erst LAN, dann Internet
  paperless_token  text,
  n8n_mail_url     text,
  n8n_mail_key     text,
  n8n_ep3_url      text,                           -- Webhook „TCO EP3 Import Hallenrechnungen“
  n8n_ep3_auth     text,                           -- optional: Authorization-Header
  halle_stichtag   date not null default '2026-01-01',
  halle_ausschluss text not null default 'GESPERRT HALLENSÄUBERUNG,JUGENDTRAINING,SCHNUPPERTRAINING',
  updated_at       timestamptz not null default now()
);
insert into tco.verein (id) values (1);
select core.enable_audit('tco.verein', 'TCO_VEREIN', 'id', 'paperless_token,n8n_mail_key,n8n_ep3_auth', 'updated_at,logo');

-- ---------------------------------------------------------------------------
-- Mitglieder
-- ---------------------------------------------------------------------------
create table tco.mitglieder (
  adrnr          text primary key,
  anrede         text, vorname text, nachname text, strasse text, plz text, ort text,
  telefon        text, email text, geschlecht text,
  bank1          text, blz1 text, konto1 text,
  geburtsdatum   date, eintritt date, austritt date,
  telefon6       text,                    -- Mobilnummer
  zahlungsart    text, zahlungsweise text, mitglnrn text, aktiv text, abwkontoinh text,
  checkbox1      text, checkbox2 text, checkbox3 text,
  iban1          text, bic1 text,
  adrnrkih       text,                    -- abweichender Zahler (ADRNR)
  mandatsrefenz  text, einzuglastmandliegtvor text,
  strassekih     text, plzkih text, ortkih text, emailkih text,
  alphabet       text, status text
);
create index mitglieder_name_idx on tco.mitglieder (lower(vorname), lower(nachname));
select core.enable_audit('tco.mitglieder', 'MITGLIED', 'adrnr');

create table tco.mitgliedera (
  adrnr   text primary key,
  trainer boolean not null default false,
  zuid    text
);
select core.enable_audit('tco.mitgliedera', 'MITGLIED', 'adrnr');

create table tco.mgnotiz (
  adrnr text not null, notiz_id text not null default replace(gen_random_uuid()::text, '-', ''),
  erstellt_am timestamptz not null default now(), erstellt_von text, notiz text,
  primary key (adrnr, notiz_id)
);

create table tco.sepa (
  adrnr text primary key, mandatsnr text, mandkey text, lastschriftart text, typ text, status text,
  angelegtam date, gueltigbis date, manuell_aktiv boolean not null default false
);
select core.enable_audit('tco.sepa', 'MITGLIED', 'adrnr');

create table tco.beitrag (
  art text primary key, bezeichnung text, turnus text, erloeskonto text, aktiv boolean not null default true,
  ernam text, erdat date, aenam text, aedat date
);
select core.enable_audit('tco.beitrag', 'BEITRAG', 'art', '', 'aenam,aedat');

create table tco.beitrag_pr (
  art text not null, gueltig_ab date not null, gueltig_bis date, betrag numeric(15,2), aenam text, aedat date,
  primary key (art, gueltig_ab)
);
select core.enable_audit('tco.beitrag_pr', 'BEITRAG', 'art', '', 'aenam,aedat');

create table tco.vertraege (
  adrnr text not null, vertragnr text not null, art text, artname text, mitglnr text, sollstellung text,
  vertragbegin date, vertragende date, betrag numeric(15,2), zahler_adrnr text, betrag_indiv boolean not null default false,
  primary key (adrnr, vertragnr)
);
select core.enable_audit('tco.vertraege', 'MITGLIED', 'adrnr');

create table tco.kommpref (
  adrnr text primary key, kanal text check (kanal in ('E','W')), geaendert_am date, geaendert_von text
);
select core.enable_audit('tco.kommpref', 'KOMMPREF', 'adrnr', '', 'geaendert_am,geaendert_von');

create table tco.schluessel (
  adrnr text primary key, counter text, ausgabe date, ausgabebeleg text, ruecknahme date, ruecknahmebeleg text
);
select core.enable_audit('tco.schluessel', 'SCHLUESSEL', 'adrnr');

create table tco.antrag_map (
  typ text not null, muster text not null, ziel text, sortnr int, primary key (typ, muster)
);

-- ---------------------------------------------------------------------------
-- Hallenbuchungen (EP3) und Hallenrechnungen
-- ---------------------------------------------------------------------------
create table tco.kunden (
  zuid text not null, zalias text not null, status text, email text, vorname text, nachname text,
  strasse text, plz text, wohnort text, telefonnummer text, geschlecht text,
  primary key (zuid, zalias)
);

create table tco.bookings (
  bid         text not null,
  datum       date not null,
  time_start  time, time_ende time,
  kunde       text,                       -- EP3-Name in Großschrift
  status      text,                       -- 1 Einzel, 2 storniert, 3 Abo, 4 entfallen
  description text, time text, preis numeric(15,2),
  erstellt    date, geaendert date,
  assigned    text,                       -- 'Y' = abgerechnet/irrelevant
  text        text,
  primary key (bid, datum)
);
create index bookings_offen_idx on tco.bookings (kunde) where coalesce(assigned, '') = '';

create table tco.bookings_ch (bid text primary key, status_abw text);
select core.enable_audit('tco.bookings_ch', 'BUCHUNG', 'bid');

create table tco.bookingstxt (bid text primary key, text text);

create table tco.produkte (
  prod_key text not null, valid_from date not null, valid_to date not null,
  text text, preis numeric(15,2), typ text, menge text,
  primary key (prod_key, valid_from, valid_to)
);
select core.enable_audit('tco.produkte', 'HALLENPREIS', 'prod_key,valid_from');

create table tco.prmatrix (
  prod_key text not null, valid_from date not null, valid_to date not null,
  tag text not null,                      -- MONTAG … SONNTAG
  zeit_von time not null, zeit_bis time not null,
  primary key (prod_key, valid_from, valid_to, tag, zeit_von, zeit_bis)
);

create table tco.rgkopf (
  rgnr_txt    text primary key,           -- JJJJ_nnn
  jahr        int, rgnr int,
  kunde       text,
  betrag      numeric(15,2) not null default 0,
  waers       text default 'EUR',
  status      text not null default '1',  -- 1 In Bearbeitung … 6 Forderung ausgefallen
  angelegt_am date, gedruckt date, versendet date, bezahlt date,
  adrnr       text,
  doknr       text                         -- Paperless-Stammdokument
);
create index rgkopf_kunde_idx on tco.rgkopf (kunde);
select core.enable_audit('tco.rgkopf', 'RECHNUNG', 'rgnr_txt');

create table tco.rgpos (
  rgnr_txt    text not null references tco.rgkopf(rgnr_txt),
  rgpos       int not null,
  bid         text, datum date, time_start time, time_ende time,
  dauer       text,                       -- Buchung: Minuten; manuelle Position: Menge
  prod_key    text,
  preis       numeric(15,2),              -- Buchung: Betrag; manuell: Einzelpreis
  description text,
  primary key (rgnr_txt, rgpos)
);
create index rgpos_bid_idx on tco.rgpos (bid, datum);
select core.enable_audit('tco.rgpos', 'RECHNUNG', 'rgnr_txt');

create table tco.rgtz (
  rgnr_txt text not null, fibeleg text not null, adrnr text, nachname text, vorname text, betrag numeric(15,2),
  primary key (rgnr_txt, fibeleg)
);
select core.enable_audit('tco.rgtz', 'RECHNUNG', 'rgnr_txt');

-- ---------------------------------------------------------------------------
-- Finanzen
-- ---------------------------------------------------------------------------
create table tco.fikonten (
  konto text primary key, name text, kennzahl text, verrechnung text, anteil text, profitcenter text
);
select core.enable_audit('tco.fikonten', 'FIKONTO', 'konto');

create table tco.fikontojahr (
  konto text not null, jahr int not null, aktiv boolean not null default true,
  geaendert_am timestamptz, geaendert_von text, primary key (konto, jahr)
);
select core.enable_audit('tco.fikontojahr', 'FIKONTO', 'konto', '', 'geaendert_am,geaendert_von');

create table tco.fibuchungen (
  internenr text not null, konto text not null, posnr int not null,
  jahr int, monat int, datum date, text text, betrag numeric(15,2),
  belnr text, gkonto text, soll numeric(15,2), haben numeric(15,2),
  rgnr_txt text, projekt text, paperless_atta text,
  primary key (internenr, konto, posnr)
);
create index fibuchungen_konto_idx on tco.fibuchungen (konto, jahr);
create index fibuchungen_rg_idx on tco.fibuchungen (rgnr_txt);
select core.enable_audit('tco.fibuchungen', 'FIBELEG', 'internenr');

create table tco.fibankab (
  jahr int not null, konto text not null, anfangsbestand numeric(15,2), endbestand numeric(15,2),
  primary key (jahr, konto)
);
select core.enable_audit('tco.fibankab', 'FIBANKAB', 'jahr,konto');

create table tco.finotiz (
  internenr text not null, notiz_id text not null default replace(gen_random_uuid()::text, '-', ''),
  erstellt_am timestamptz not null default now(), erstellt_von text, notiz text,
  primary key (internenr, notiz_id)
);

create table tco.fipapermap (
  internenr text not null, konto text not null, doknr text not null, betrag numeric(15,2),
  primary key (internenr, konto, doknr)
);
select core.enable_audit('tco.fipapermap', 'FIBELEG', 'internenr');

create table tco.paperless (
  internenr text not null, uuid text not null, doknr text, created_at date, primary key (internenr, uuid)
);

create table tco.projekte (
  projektnr text not null, jahr int not null, abgeschlossen date, primary key (projektnr, jahr)
);

create table tco.anlagen (
  anlnr int primary key, bezeichnung text, anschdat date, anschwert numeric(15,2), nutzdauer int, monate_ej int,
  notiz text, erstellt_von text, erstellt_am timestamptz, geaendert_am timestamptz
);
select core.enable_audit('tco.anlagen', 'ANLAGE', 'anlnr', '', 'erstellt_am,geaendert_am');

-- ---------------------------------------------------------------------------
-- Sollstellung (SEPA-Lastschrift)
-- ---------------------------------------------------------------------------
create table tco.soll_cfg (
  cfgid text primary key, gl_name text, iban text, bic text, gl_id text, bankkonto text, vorlauf int, aenam text, aedat date
);
select core.enable_audit('tco.soll_cfg', 'SOLL_CFG', 'cfgid', '', 'aenam,aedat');

create table tco.soll_kopf (
  laufid text primary key, sollper text, mit_mb boolean, mit_jt boolean, faellig date, msgid text,
  anz_pos int, anz_tx int, summe numeric(15,2), status text, zahl_datum date, fi_datum date,
  ernam text, erdat date, erzeit time, xml text, pl_doc_id int
);
select core.enable_audit('tco.soll_kopf', 'SOLLSTELLUNG', 'laufid', '', 'xml');

create table tco.soll_pos (
  sollper text not null, adrnr text not null, vertragnr text not null,
  laufid text, art text, artname text, beitragsart text, betrag numeric(15,2), konto text, mitglnr text,
  mitglied_name text, zahler_adrnr text, zahler_name text, fi_name text, iban text, bic text,
  mandatsref text, mandatsdatum date, e2e_id text, status text, internenr text, fi_posnr int,
  primary key (sollper, adrnr, vertragnr)
);
select core.enable_audit('tco.soll_pos', 'SOLLSTELLUNG', 'laufid');

-- ---------------------------------------------------------------------------
-- Clubhaus / Getränke
-- ---------------------------------------------------------------------------
create table tco.ford (
  jahr int not null, monat int not null, datum int not null,
  vkbrutto numeric(15,2), reinigung numeric(15,2), provision numeric(15,2), forderung numeric(15,2),
  ekbrutto numeric(15,2), einzahlung numeric(15,2),
  primary key (jahr, monat, datum)
);
create table tco.forderungen (
  jahr int not null, monat int not null, rechnung text, ekbrutto numeric(15,2), vkbrutto numeric(15,2),
  reinigung numeric(15,2), provision numeric(15,2), forderung numeric(15,2), einzahlungen numeric(15,2),
  offene_posten numeric(15,2), waers text, primary key (jahr, monat)
);
create table tco.werg (
  rgnr text not null, rgpos int not null, datum date, produkt text, anzahl numeric(15,3), ekpreis numeric(15,2),
  primary key (rgnr, rgpos)
);
create table tco.werg_beleg (
  rgnr text not null, doknr text not null, internenr text, zuord_art text, titel text, belegdatum date,
  betrag numeric(15,2), erdat date, primary key (rgnr, doknr)
);
create table tco.werg_pl (
  rgnr text primary key, doknr text, internenr text, zuord_art text, titel text, erdat date
);

-- ---------------------------------------------------------------------------
-- Jugendtraining
-- ---------------------------------------------------------------------------
create table tco.jrueckm (
  zalias text not null, adrnr text not null, datum date not null, trainingsart text not null,
  anzahl numeric(9,2), abgerechnet text,
  primary key (zalias, adrnr, datum, trainingsart)
);
create table tco.jt_doku (
  adrnr text not null, monat text not null, belegnr text, doc_id int, erstellt_am date, erstellt_um time,
  erstellt_von text, bezahlt_am date, stunden numeric(9,2), betrag numeric(15,2), bezahlt_betrag numeric(15,2),
  primary key (adrnr, monat)
);
select core.enable_audit('tco.jt_doku', 'JT_NACHWEIS', 'adrnr,monat');
create table tco.trentgelt (
  adrnr text not null, valid_to date not null, betrag numeric(15,2), primary key (adrnr, valid_to)
);
select core.enable_audit('tco.trentgelt', 'TRAINERENTGELT', 'adrnr');
create table tco.tplan (
  datum_von date not null, datum_bin date not null, wochentag text not null, adrnr text not null, anzahl int,
  primary key (datum_von, datum_bin, wochentag, adrnr)
);
create table tco.tfrei (datum_von date primary key, datum_bis date, grund text);
create table tco.ferien (
  datum date primary key, jahr int, ferien text, geladen_am timestamptz, geladen_von text
);
