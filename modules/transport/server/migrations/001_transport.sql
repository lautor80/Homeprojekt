-- ============================================================================
-- Modul "transport" – Auftragsverwaltung (Nachfolger ZEU_AUFTRAG / Z2UI5_CL_EU_AUFTRAG)
--   SAP-Tabelle            → neue Tabelle
--   ZEU_ADRESSEN           → transport.adressen
--   ZEU_AUFTRAG            → transport.auftraege
--   ZEU_AUFTAG_POS(1)      → transport.stops
--   ZEU_TRAEGER            → transport.traeger
--   ZEU_PRODUKTE           → transport.produkte
--   Domänen ZEU_LADEART,
--   ZEU_LADEGUT, ZEU_LADE-
--   WEISE, ZEU_PALETTEN-
--   TAUSCH (DD07T)         → transport.werte
--   SO10-Texte ZEU_EMAIL_* → transport.mailtexte
--   ZEU_RGNRKREIS          → core.number_ranges (AUFTRAG / RECHNUNG je Jahr)
--   Konstanten C_SELLER    → transport.firma
-- ============================================================================
create schema if not exists transport;

-- ---------------------------------------------------------------------------
-- Firmendaten (Rechnungssteller) – genau eine Zeile
-- ---------------------------------------------------------------------------
create table transport.firma (
  id                 smallint primary key default 1 check (id = 1),
  name               text not null default '',
  strasse            text not null default '',
  plz                text not null default '',
  ort                text not null default '',
  land               text not null default 'DE',
  ustid              text not null default '',
  steuernr           text not null default '',
  kontakt            text not null default '',
  telefon            text not null default '',
  fax                text not null default '',
  email              text not null default '',
  bank               text not null default '',
  iban               text not null default '',
  bic                text not null default '',
  zahlungsziel_tage  integer not null default 14,
  ust_satz           numeric(5,2) not null default 19,
  rechnung_startnr   integer not null default 5001,   -- erste Rechnungsnummer je Jahr
  logo               text,                             -- Data-URL (PNG/JPEG) für Ausdrucke
  paperless_url      text not null default '',
  paperless_token    text not null default '',
  updated_at         timestamptz not null default now()
);
insert into transport.firma (id) values (1);
create trigger firma_touch before update on transport.firma
  for each row execute function core.touch_updated_at();
select core.enable_audit('transport.firma', 'FIRMA', 'id', 'paperless_token', 'updated_at');

-- ---------------------------------------------------------------------------
-- Adressen / Kontakte (Kunde, Unternehmer, Rechnungsempfänger)
-- ---------------------------------------------------------------------------
create table transport.adressen (
  adrnr        integer primary key,
  kundenname   text not null default '',
  kundenname2  text,
  anrede       text,
  name         text,
  vorname      text,
  strasse      text,
  hausnummer   text,
  land         text,
  plz          text,
  ort          text,
  telefon      text,
  fax          text,
  email        text,
  gln          text,
  markt        text,
  ustid        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index adressen_name_idx on transport.adressen (lower(kundenname));
create trigger adressen_touch before update on transport.adressen
  for each row execute function core.touch_updated_at();
select core.enable_audit('transport.adressen', 'ADRESSE', 'adrnr');

-- ---------------------------------------------------------------------------
-- Wertelisten (ehemals Festwerte der Domänen)
-- ---------------------------------------------------------------------------
create table transport.werte (
  typ         text not null check (typ in ('FAHRZEUGTYP', 'LADEGUT', 'LADEWEISE', 'PALETTENTAUSCH')),
  schluessel  text not null,
  text        text not null,
  sort        integer not null default 0,
  aktiv       boolean not null default true,
  primary key (typ, schluessel)
);
select core.enable_audit('transport.werte', 'WERT', 'typ,schluessel');

-- ---------------------------------------------------------------------------
-- Produkte (Holzträger)
-- ---------------------------------------------------------------------------
create table transport.produkte (
  prod_key     text primary key,
  text         text not null,
  preis        numeric(9,2) not null default 0,
  gueltig_bis  date,
  sort         integer not null default 0
);
select core.enable_audit('transport.produkte', 'PRODUKT', 'prod_key');

-- ---------------------------------------------------------------------------
-- Aufträge
-- ---------------------------------------------------------------------------
create table transport.auftraege (
  auftragsnr          text primary key,                 -- JJJJ_NNNN
  anlagedatum         date not null default current_date,
  kunde               integer references transport.adressen(adrnr),
  unternehmer         integer references transport.adressen(adrnr),
  rechnungsempfaenger integer references transport.adressen(adrnr),
  rgbetrag            numeric(15,2) not null default 0,
  kennzeichen         text,
  fahrzeugtyp         text,                             -- ZEU_AUFTRAG-ART
  frachtpreis_ek      numeric(15,2) not null default 0,
  frachtpreis_vk      numeric(15,2) not null default 0,
  ladenummer          text,
  ladegut             text,
  gewicht             text,
  ladeweise           text,
  palettentausch      text,
  ordernummer         text,
  datumladen1         date,
  datumentladen1      date,
  besonderheiten      text,                             -- Langtext (ehem. SO10-Text zum Auftrag)
  faktura             text,
  fakturadatum        date,
  steuerrelevant      boolean not null default true,
  dok_fehlen          boolean not null default false,
  leistungsdatum      date,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index auftraege_faktura_idx on transport.auftraege (faktura);
create index auftraege_anlage_idx on transport.auftraege (anlagedatum);
create trigger auftraege_touch before update on transport.auftraege
  for each row execute function core.touch_updated_at();
select core.enable_audit('transport.auftraege', 'AUFTRAG', 'auftragsnr');

-- Stops (Lade-/Entladestellen) – Änderungen erscheinen in der Historie des Auftrags
create table transport.stops (
  auftragsnr  text not null references transport.auftraege(auftragsnr) on delete cascade,
  pos         smallint not null,
  firma       text,
  strasse     text,
  land        text,
  plzort      text,
  ladenummer  text,
  datum       date,
  zeit        text,
  firma_e     text,
  strasse_e   text,
  land_e      text,
  plzort_e    text,
  datum_e     date,
  zeit_e      text,
  primary key (auftragsnr, pos)
);
select core.enable_audit('transport.stops', 'AUFTRAG', 'auftragsnr');

-- Holzträger je Auftrag
create table transport.traeger (
  auftragsnr  text not null references transport.auftraege(auftragsnr) on delete cascade,
  pos         smallint not null,
  produkt     text,
  prod_txt    text,
  menge       integer not null default 0,
  preis       numeric(9,2) not null default 0,
  primary key (auftragsnr, pos)
);
select core.enable_audit('transport.traeger', 'AUFTRAG', 'auftragsnr');

-- ---------------------------------------------------------------------------
-- E-Mail-Texte (T = Transportauftrag, L = Lieferschein, R = Rechnung; D/E)
-- ---------------------------------------------------------------------------
create table transport.mailtexte (
  art      char(1) not null check (art in ('T', 'L', 'R')),
  sprache  char(1) not null check (sprache in ('D', 'E')),
  text     text not null default '',
  primary key (art, sprache)
);
insert into transport.mailtexte (art, sprache, text) values
  ('T', 'D', E'{ANREDE},\n\nanbei erhalten Sie den Transportauftrag {AUFTRAG}.\n\nMit freundlichen Grüßen'),
  ('T', 'E', E'Dear Sir or Madam,\n\nplease find attached the transport order {AUFTRAG}.\n\nBest regards'),
  ('L', 'D', E'{ANREDE},\n\nanbei erhalten Sie den Lieferschein zum Auftrag {AUFTRAG}.\n\nMit freundlichen Grüßen'),
  ('L', 'E', E'Dear Sir or Madam,\n\nplease find attached the delivery note for order {AUFTRAG}.\n\nBest regards'),
  ('R', 'D', E'{ANREDE},\n\nanbei erhalten Sie die Rechnung {RECHNUNG}.\n\nMit freundlichen Grüßen'),
  ('R', 'E', E'Dear Sir or Madam,\n\nplease find attached the invoice {RECHNUNG}.\n\nBest regards');
select core.enable_audit('transport.mailtexte', 'MAILTEXT', 'art,sprache');
