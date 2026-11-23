-- Hallenrechnungen per SEPA-Lastschrift: Einstellungen, Zahlart/Mandat je Person, eigener manueller Lastschriftlauf
-- (technisch ein Lauf der Sollstellung mit typ = 'HALLE', damit der Bankimport die Sammelgutschrift erkennt) und
-- Rücklastschriften mit Gebühr auf der Rechnung.

-- Einstellungen (eine Zeile). aktiv = false: kein Hinweis an die Hallenbucher, Rechnungen gehen wie bisher per Überweisung.
create table if not exists tco.halle_ls_cfg (
  id              int primary key default 1 check (id = 1),
  aktiv           boolean not null default false,
  -- Vorabankündigung (Pre-Notification): frühester Einzug = Druckdatum der Rechnung + so viele Tage
  vorankuendigung int not null default 5 check (vorankuendigung between 1 and 30),
  -- Gebühr je Rücklastschrift, die der Rechnung hinzugefügt wird; leer = die tatsächliche Bankgebühr aus dem Kontoauszug
  gebuehr         numeric(15,2) check (gebuehr is null or gebuehr >= 0),
  -- Konto der Bankgebühr (Aufwand) und der Gebührenposition auf der Rechnung
  gebuehr_konto   text not null default '4970',
  geaendert_von   text,
  geaendert_am    timestamptz
);
insert into tco.halle_ls_cfg (id) values (1) on conflict (id) do nothing;
select core.enable_audit('tco.halle_ls_cfg', 'HALLE_LS_CFG', 'id', '', 'geaendert_von,geaendert_am');

-- Entscheidung der Person für die Zahlart ihrer Hallenrechnungen. adrnr wie an der Rechnung: Mitglied (00…) oder
-- Hallenkunde (99 + ZUID). quelle MITGLIED = Bankverbindung und Mandat der Mitgliedschaft (beim Lauf aktuell gelesen),
-- EIGEN = eigenes Mandat für die Hallenrechnungen (online im Portal erteilt oder von der Verwaltung erfasst).
create table if not exists tco.halle_zahlart (
  adrnr          text primary key,
  zahlart        text not null check (zahlart in ('LASTSCHRIFT', 'UEBERWEISUNG')),
  quelle         text check (quelle in ('MITGLIED', 'EIGEN')),
  kontoinhaber   text,
  iban           text,
  bic            text,
  mandatsref     text unique,
  mandatsdatum   date,
  mandatstext    text,
  status         text not null default 'AKTIV' check (status in ('AKTIV', 'WIDERRUFEN')),
  erfasst_ueber  text not null default 'PORTAL' check (erfasst_ueber in ('PORTAL', 'VERWALTUNG')),
  entschieden_am timestamptz not null default now(),
  entschieden_von text,
  benutzer_id    uuid references core.users(id) on delete set null,
  ip             text,
  widerrufen_am  timestamptz,
  widerrufen_von text,
  grund          text,
  check (zahlart = 'UEBERWEISUNG' or quelle is not null)
);
select core.enable_audit('tco.halle_zahlart', 'HALLE_ZAHLART', 'adrnr', '', 'ip');

-- Zahlart der einzelnen Rechnung: wird beim ersten Druck festgeschrieben (null = noch offen / Überweisung);
-- einzug_ab = angekündigter frühester Einzug; laufid = Lastschriftlauf, in dem die Rechnung steckt
alter table tco.rgkopf
  add column if not exists zahlart   text check (zahlart is null or zahlart in ('LASTSCHRIFT', 'UEBERWEISUNG')),
  add column if not exists einzug_ab date,
  add column if not exists laufid    text;
create index if not exists rgkopf_laufid_idx on tco.rgkopf (laufid) where laufid is not null;

-- Lastschriftläufe: Beiträge (Sollstellung) und Hallenrechnungen teilen Kopf, Positionen und Nummernkreis
alter table tco.soll_kopf add column if not exists typ text not null default 'BEITRAG' check (typ in ('BEITRAG', 'HALLE'));
alter table tco.soll_pos
  add column if not exists rgnr_txt        text,
  add column if not exists sequenz         text,
  add column if not exists rueck_internenr text,
  add column if not exists rueck_datum     date,
  add column if not exists rueck_gebuehr   numeric(15,2),
  add column if not exists rueck_rgpos     int;

-- Recht für den Lauf, die Mandate und die Einstellungen: wer die Sollstellung ausführen darf
insert into core.role_permissions (role_id, permission)
select distinct role_id, 'tco.halle:lastschrift' from core.role_permissions where permission = 'tco.soll:edit'
on conflict do nothing;
