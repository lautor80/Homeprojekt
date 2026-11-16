-- Mahnwesen: Zahlungserinnerung und Mahnlauf für offene Hallenrechnungen und gestellte Verzehrabrechnungen.
-- Einstellungen (Administration → Einstellungen → TC Oberthal → Mahnwesen), Läufe, Posten je Lauf (Mahnhistorie je Rechnung)
-- und Mahnsperren. Sicherheitsvorgabe: Die Automatik ist nach dem Einspielen AUS (aktiv = false) – ohne bewusstes Einschalten
-- geht keine E-Mail hinaus; eingeschaltet erzeugt sie zunächst nur einen Vorschlag (modus = 'VORSCHLAG').

create table if not exists tco.mahn_cfg (
  id                int primary key default 1 check (id = 1),
  aktiv             boolean not null default false,                -- automatischer Lauf im Hintergrund
  modus             text not null default 'VORSCHLAG' check (modus in ('VORSCHLAG', 'SENDEN')),
  wochentage        text not null default '1',                     -- ISO-Wochentage, Komma-Liste: 1 = Montag … 7 = Sonntag
  uhrzeit           text not null default '08:00' check (uhrzeit ~ '^[0-2][0-9]:[0-5][0-9]$'),
  zahlungsziel_tage int check (zahlungsziel_tage between 0 and 90), -- leer = Zahlungsziel des Vereins (Verein und Bank)
  frist_tage        int not null default 10 check (frist_tage between 1 and 60),   -- neue Zahlungsfrist in der E-Mail
  -- Stufen in Reihenfolge: tage = Tage nach Fälligkeit (erste Stufe) bzw. nach der vorherigen Stufe; gebuehr = Mahngebühr in Euro
  stufen            jsonb not null default '[{"name":"Zahlungserinnerung","tage":7,"gebuehr":0},{"name":"1. Mahnung","tage":14,"gebuehr":0},{"name":"2. Mahnung","tage":14,"gebuehr":0}]',
  mindestbetrag     numeric(10, 2) not null default 5 check (mindestbetrag >= 0),  -- je Schuldner; darunter wird nicht gemahnt
  max_je_lauf       int not null default 50 check (max_je_lauf between 1 and 500), -- höchstens so viele E-Mails je Lauf
  arten             text not null default 'HALLE,VERZEHR',         -- welche Posten-Arten gemahnt werden
  halle_gedruckt    boolean not null default false,                -- auch gedruckte, nicht als versendet gekennzeichnete Hallenrechnungen
  anhang            boolean not null default true,                 -- Rechnung bzw. Abrechnung als PDF (mit GiroCode) beilegen
  absender          text not null default '',                      -- leer = Absender der Anbindung „mail“ (Anwendung MAHNUNG)
  absender_name     text not null default '',
  antwort_an        text not null default '',
  kopie_an          text not null default '',                      -- Blindkopie jeder Mahnung (Kassenwart)
  letzter_lauf      timestamptz                                    -- letzter automatischer Lauf (einmal je Tag)
);
insert into tco.mahn_cfg (id) values (1) on conflict do nothing;
select core.enable_audit('tco.mahn_cfg', 'MAHN_CFG', 'id', '', 'letzter_lauf');

create table if not exists tco.mahn_lauf (
  id              serial primary key,
  art             text not null check (art in ('AUTO', 'MANUELL')),
  modus           text not null check (modus in ('VORSCHLAG', 'SENDEN')),
  -- LAEUFT = in Arbeit (Sperre gegen Doppelläufe), VORSCHLAG = wartet auf Freigabe
  status          text not null default 'LAEUFT' check (status in ('LAEUFT', 'VORSCHLAG', 'FERTIG', 'FEHLER', 'VERWORFEN')),
  stichtag        date not null,
  gestartet_am    timestamptz not null default now(),
  gestartet_von   text not null,
  beendet_am      timestamptz,
  freigegeben_am  timestamptz,
  freigegeben_von text,
  zurueckgestellt int not null default 0,                          -- Schuldner über der Obergrenze: kommen im nächsten Lauf
  meldung         text
);
-- Schutz gegen Doppelläufe: höchstens ein Lauf ist in Arbeit
create unique index if not exists mahn_lauf_einer on tco.mahn_lauf ((true)) where status = 'LAEUFT';

create table if not exists tco.mahn_posten (
  id           serial primary key,
  lauf_id      int not null references tco.mahn_lauf (id) on delete cascade,
  art          text not null check (art in ('HALLE', 'VERZEHR')),
  nr           text not null,                                      -- Rechnungs- bzw. Belegnummer
  schuldner    text not null,                                      -- Adressnummer (Mitglied oder Kunde 99…), sonst „K:<Name>“
  name         text not null,
  betrag       numeric(15, 2) not null,                            -- offener Betrag zum Zeitpunkt der Mahnung
  faellig      date not null,
  stufe        int not null check (stufe between 1 and 4),
  stufe_name   text not null,
  gebuehr      numeric(10, 2) not null default 0,                  -- Mahngebühr der E-Mail (einmal je Schuldner, am ersten Posten)
  frist        date,                                               -- neue Zahlungsfrist
  -- GESENDET = zugestellt (E-Mail bzw. von Hand vermerkt), NICHT_ERREICHBAR = keine Adresse/Versand abgelehnt,
  -- FEHLER = technischer Fehler (wird im nächsten Lauf wiederholt), ENTFALLEN = vor dem Senden bezahlt oder gesperrt
  status       text not null default 'VORSCHLAG' check (status in ('VORSCHLAG', 'GESENDET', 'NICHT_ERREICHBAR', 'FEHLER', 'ENTFALLEN', 'VERWORFEN')),
  weg          text check (weg in ('MAIL', 'BRIEF', 'TELEFON', 'PERSOENLICH')),
  an           text,                                               -- E-Mail-Adresse des Versuchs
  meldung      text,
  erledigt_am  timestamptz,
  erledigt_von text,
  angelegt_am  timestamptz not null default now()
);
-- je Posten und Stufe nur einmal: höchstens ein Vorschlag bzw. eine zugestellte Mahnung
create unique index if not exists mahn_posten_einmal on tco.mahn_posten (art, nr, stufe) where status in ('VORSCHLAG', 'GESENDET');
create index if not exists mahn_posten_nr on tco.mahn_posten (art, nr);
create index if not exists mahn_posten_lauf on tco.mahn_posten (lauf_id);
select core.enable_audit('tco.mahn_posten', 'MAHNUNG', 'id');

create table if not exists tco.mahn_sperre (
  id             serial primary key,
  ebene          text not null check (ebene in ('RECHNUNG', 'SCHULDNER')),
  art            text check (art in ('HALLE', 'VERZEHR')),          -- nur Ebene RECHNUNG
  schluessel     text not null,                                    -- Rechnungsnummer bzw. Schuldner (Adressnummer)
  name           text not null default '',
  grund          text not null,
  bis            date,                                             -- leer = bis auf Widerruf
  angelegt_am    timestamptz not null default now(),
  angelegt_von   text not null,
  aufgehoben_am  timestamptz,
  aufgehoben_von text,
  check ((ebene = 'RECHNUNG') = (art is not null))
);
create index if not exists mahn_sperre_schluessel on tco.mahn_sperre (schluessel);
select core.enable_audit('tco.mahn_sperre', 'MAHN_SPERRE', 'id');
