-- Hallenschlüssel (#215): Ausgabe und Rückgabe als Vorgänge mit „ausgegeben/empfangen von (TCO)“, Online-Quittung des Kunden,
-- Empfangsbestätigung des TCO, Beleg in Paperless, Rechnungsposition/Gutschrift in der Hallenrechnung bzw. (Altfälle) FI-Buchung
-- auf dem Kassenkonto. tco.schluessel bleibt der aktuelle Stand je Person (ein Schlüssel je Person) und wird fortgeschrieben.
-- Schlüssel sind nicht nummeriert: schluessel_nr ist ein freies Feld, kein Schlüsselmerkmal.

create table if not exists tco.schluessel_vorgang (
  id              serial primary key,
  nummer          text not null unique,                  -- SV-JJJJ-NNNN
  art             text not null check (art in ('AUSGABE', 'RUECKGABE')),
  adrnr           text not null,                         -- Mitglied oder EP3-Kunde (99…)
  person          text not null,
  datum           date not null,
  schluessel_nr   text,                                  -- optional, frei
  pfand           numeric(10, 2),
  zustand         text check (zustand in ('OK', 'BESCHAEDIGT', 'VERLOREN')),
  tco_benutzer_id uuid references core.users (id) on delete set null,
  tco_name        text not null default '',              -- ausgegeben von / empfangen von (TCO)
  status          text not null default 'WARTET' check (status in ('WARTET', 'QUITTIERT', 'STORNIERT')),
  quittiert_am    timestamptz,
  quittiert_von   text,
  quittiert_art   text check (quittiert_art in ('KUNDE', 'TCO', 'ALTFALL')),
  nachweis        text,
  token           text unique,                           -- Quittungslink des Kunden
  token_bis       timestamptz,
  rgnr            text,                                  -- Hallenrechnung (Position bzw. Gutschrift)
  rgpos           int,
  internenr       text,                                  -- FI-Buchung (Altfälle: Kassenkonto)
  doc_id          int,                                   -- Beleg in Paperless
  quelle          text not null default 'APP' check (quelle in ('APP', 'RECHNUNG', 'IMPORT', 'BESTAND')),
  bemerkung       text,
  erinnert_am     timestamptz,
  angelegt_am     timestamptz not null default now(),
  angelegt_von    text not null default ''
);
create index if not exists schluessel_vorgang_adrnr_idx on tco.schluessel_vorgang (adrnr, datum);
select core.enable_audit('tco.schluessel_vorgang', 'SCHLUESSELVORGANG', 'id', '', 'token,token_bis,erinnert_am');

-- Protokoll: jeder Schritt mit Zeitstempel, Benutzer und Aktion
create table if not exists tco.schluessel_verlauf (
  id          serial primary key,
  vorgang_id  int not null references tco.schluessel_vorgang (id) on delete cascade,
  am          timestamptz not null default now(),
  von         text not null,
  benutzer_id uuid references core.users (id) on delete set null,
  aktion      text not null,
  text        text
);
create index if not exists schluessel_verlauf_idx on tco.schluessel_verlauf (vorgang_id, am);

create table if not exists tco.schluessel_cfg (
  id            int primary key default 1 check (id = 1),
  bedingungen   text not null default '',                -- leer = Standardtext
  quittung_tage int  not null default 7  check (quittung_tage between 1 and 90),    -- danach Hinweis im Arbeitsvorrat
  link_tage     int  not null default 30 check (link_tage between 1 and 365),       -- Gültigkeit des Quittungslinks
  kassenkonto   text not null default '1000'             -- Altfälle: Buchung direkt auf dieses Konto
);
insert into tco.schluessel_cfg (id) values (1) on conflict do nothing;
select core.enable_audit('tco.schluessel_cfg', 'SCHLUESSELCFG', 'id');

-- Bestand übernehmen: je Person der heutige Stand als abgeschlossene Vorgänge (Altfall)
insert into tco.schluessel_vorgang (nummer, art, adrnr, person, datum, status, quittiert_art, quelle, bemerkung, angelegt_von)
select 'neu-' || gen_random_uuid()::text, 'AUSGABE', s.adrnr,
       coalesce((select trim(coalesce(m.vorname, '') || ' ' || coalesce(m.nachname, '')) from tco.mitglieder m where m.adrnr = s.adrnr), s.adrnr),
       s.ausgabe, 'QUITTIERT', 'ALTFALL', 'BESTAND', nullif(trim(coalesce(s.ausgabebeleg, '')), ''), 'Übernahme'
  from tco.schluessel s
 where s.ausgabe is not null and not exists (select 1 from tco.schluessel_vorgang);
insert into tco.schluessel_vorgang (nummer, art, adrnr, person, datum, status, quittiert_art, quelle, bemerkung, angelegt_von)
select 'neu-' || gen_random_uuid()::text, 'RUECKGABE', s.adrnr,
       coalesce((select trim(coalesce(m.vorname, '') || ' ' || coalesce(m.nachname, '')) from tco.mitglieder m where m.adrnr = s.adrnr), s.adrnr),
       s.ruecknahme, 'QUITTIERT', 'ALTFALL', 'BESTAND', nullif(trim(coalesce(s.ruecknahmebeleg, '')), ''), 'Übernahme'
  from tco.schluessel s
 where s.ruecknahme is not null and not exists (select 1 from tco.schluessel_vorgang where art = 'RUECKGABE');
update tco.schluessel_vorgang set nummer = 'SV-' || to_char(datum, 'YYYY') || '-' || lpad(id::text, 4, '0') where nummer like 'neu-%';
