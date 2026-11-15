-- Zuwendungsbestätigungen (Spendenbescheinigungen) nach § 10b EStG / § 50 EStDV für Geldspenden.
-- Quelle sind ausschließlich FI-Buchungen (Haben) – auf den Spendenkonten bzw. aus verbuchten Sollstellungs-
-- Positionen der Spenden-Beitragsarten. Jede Buchungszeile gehört höchstens einer gültigen Bestätigung.

-- ---------------------------------------------------------------------------
-- Einstellungen (Administration → Einstellungen → TC Oberthal → Zuwendungsbestätigungen)
-- ---------------------------------------------------------------------------
create table if not exists tco.zuw_cfg (
  id                  int primary key default 1 check (id = 1),
  bescheid_art        text not null default '' check (bescheid_art in ('', 'FREISTELLUNG', 'FESTSTELLUNG')),
  finanzamt           text not null default '',
  steuernummer        text not null default '',
  bescheid_datum      date,
  veranlagungszeitraum text not null default '',          -- nur Freistellungsbescheid („letzter Veranlagungszeitraum“)
  zweck               text not null default 'Förderung des Sports',
  zweck_satzung       text not null default 'den Sport',  -- nur § 60a AO: „Wir fördern nach unserer Satzung …“
  unterzeichner       text not null default '',
  funktion            text not null default '',
  ort                 text not null default '',
  unterschrift        text,                               -- Data-URL (PNG/JPEG) eines Unterschriftsbilds, optional
  spendenkonten       text not null default '',           -- Komma-Liste Erlöskonten, deren Haben-Buchungen Spenden sind
  spendenarten        text not null default '',           -- Komma-Liste Beitragsarten (Sollstellung), die Spenden sind
  mail_erlaubt        boolean not null default false,     -- Versand der PDF per E-Mail zugelassen (Verantwortung des Vereins)
  texte               jsonb not null default '{}',        -- vom Verein geänderte Textbausteine (Schlüssel → Text)
  muster_geprueft_am  timestamptz,                        -- Wortlaut mit dem amtlichen Muster abgeglichen
  muster_geprueft_von text,
  geaendert_am        timestamptz,
  geaendert_von       text
);
insert into tco.zuw_cfg (id) values (1) on conflict do nothing;
select core.enable_audit('tco.zuw_cfg', 'ZUW_CFG', 'id', '', 'geaendert_am,geaendert_von,unterschrift');

-- ---------------------------------------------------------------------------
-- Spender ohne Mitgliedschaft
-- ---------------------------------------------------------------------------
create table if not exists tco.zuw_spender (
  spender_id   serial primary key,
  name         text not null,
  zusatz       text,
  strasse      text not null default '',
  plz          text not null default '',
  ort          text not null default '',
  email        text,
  erfasst_am   timestamptz not null default now(),
  erfasst_von  text
);
select core.enable_audit('tco.zuw_spender', 'ZUW_SPENDER', 'spender_id', '', 'erfasst_am,erfasst_von');

-- ---------------------------------------------------------------------------
-- Merkmale einer FI-Buchungszeile für die Zuwendungsbestätigung (von Hand gepflegt):
-- Spender, Verzicht auf Erstattung von Aufwendungen, Ausschluss (z. B. Rücklastschrift), geklärte Rückbuchung
-- ---------------------------------------------------------------------------
create table if not exists tco.zuw_merkmal (
  internenr    text not null,
  konto        text not null,
  posnr        int  not null,
  adrnr        text,                                      -- Spender ist Mitglied/Zahler
  spender_id   int references tco.zuw_spender (spender_id),
  verzicht     boolean not null default false,
  ausschluss   text check (ausschluss in ('RUECKLAST', 'KEINE_SPENDE', 'GEKLAERT')),
  grund        text,
  geaendert_am timestamptz not null default now(),
  geaendert_von text,
  primary key (internenr, konto, posnr),
  check (adrnr is null or spender_id is null)
);
select core.enable_audit('tco.zuw_merkmal', 'ZUW_QUELLE', 'internenr,konto,posnr', '', 'geaendert_am,geaendert_von');

-- ---------------------------------------------------------------------------
-- Ausgestellte Bestätigungen: unveränderlich (Doppel nach § 50 Abs. 7 EStDV), Korrektur nur per Storno und Neuausstellung
-- ---------------------------------------------------------------------------
create table if not exists tco.zuw_kopf (
  zbnr            text primary key,                       -- ZB-JJJJ-NNNN (Jahr der Zuwendung, fortlaufend)
  jahr            int  not null,
  lfdnr           int  not null,
  art             text not null check (art in ('EINZEL', 'SAMMEL')),
  status          text not null default 'A' check (status in ('A', 'S')),   -- A ausgestellt, S storniert
  adrnr           text,
  spender_id      int,
  spender_name    text not null,
  spender_anschrift text not null,                        -- Zeilen der Anschrift, wie gedruckt
  spender_email   text,
  betrag          numeric(15,2) not null check (betrag > 0),
  betrag_worte    text not null,
  tag             date,                                   -- Einzelbestätigung: Tag der Zuwendung
  zeitraum_von    date,                                   -- Sammelbestätigung
  zeitraum_bis    date,
  verzicht        boolean not null default false,
  ausgestellt_am  date not null,
  ausgestellt_von text not null,
  erstellt_am     timestamptz not null default now(),
  daten           jsonb not null,                         -- alles, was gedruckt wurde (Aussteller, Bescheid, Texte)
  pdf             bytea not null,
  pdf_sha256      text not null,
  paperless_id    int,
  paperless_am    timestamptz,
  versand_status  text not null default '' check (versand_status in ('', 'GESENDET', 'GEDRUCKT', 'NICHT_VERSENDET')),
  versand_am      timestamptz,
  versand_an      text,
  versand_hinweis text,
  storno_am       timestamptz,
  storno_von      text,
  storno_grund    text,
  unique (jahr, lfdnr)
);
create index if not exists zuw_kopf_spender on tco.zuw_kopf (adrnr, spender_id);
select core.enable_audit('tco.zuw_kopf', 'ZUWENDUNG', 'zbnr', '', 'pdf,daten,erstellt_am');

create table if not exists tco.zuw_pos (
  zbnr      text not null references tco.zuw_kopf (zbnr),
  lfd       int  not null,
  internenr text not null,
  konto     text not null,
  posnr     int  not null,
  datum     date not null,
  betrag    numeric(15,2) not null,
  art_text  text not null default 'Geldspende',
  verzicht  boolean not null default false,
  text      text,
  aktiv     boolean not null default true,                -- false nach Storno der Bestätigung
  primary key (zbnr, lfd)
);
-- keine Zuwendung doppelt: je Buchungszeile höchstens eine gültige Bestätigung
create unique index if not exists zuw_pos_quelle on tco.zuw_pos (internenr, konto, posnr) where aktiv;

-- Bestätigungen sind unveränderlich. Erlaubt bleiben: Storno (einmalig, mit Grund), Ablage in Paperless, Versandvermerk.
create or replace function tco.zuw_kopf_schutz() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Zuwendungsbestätigungen können nicht gelöscht werden – bitte stornieren (%).', old.zbnr using errcode = 'P0001';
  end if;
  if (new.zbnr, new.jahr, new.lfdnr, new.art, new.adrnr, new.spender_id, new.spender_name, new.spender_anschrift, new.spender_email,
      new.betrag, new.betrag_worte, new.tag, new.zeitraum_von, new.zeitraum_bis, new.verzicht, new.ausgestellt_am, new.ausgestellt_von,
      new.erstellt_am, new.daten, new.pdf, new.pdf_sha256)
     is distinct from
     (old.zbnr, old.jahr, old.lfdnr, old.art, old.adrnr, old.spender_id, old.spender_name, old.spender_anschrift, old.spender_email,
      old.betrag, old.betrag_worte, old.tag, old.zeitraum_von, old.zeitraum_bis, old.verzicht, old.ausgestellt_am, old.ausgestellt_von,
      old.erstellt_am, old.daten, old.pdf, old.pdf_sha256) then
    raise exception 'Zuwendungsbestätigungen können nicht geändert werden – bitte stornieren und neu ausstellen (%).', old.zbnr using errcode = 'P0001';
  end if;
  if old.status = 'S' and (new.status, new.storno_am, new.storno_von, new.storno_grund) is distinct from (old.status, old.storno_am, old.storno_von, old.storno_grund) then
    raise exception 'Die Zuwendungsbestätigung % ist storniert – das Storno kann nicht zurückgenommen werden.', old.zbnr using errcode = 'P0001';
  end if;
  if new.status = 'S' and coalesce(trim(new.storno_grund), '') = '' then
    raise exception 'Storno der Zuwendungsbestätigung % nur mit Grund.', old.zbnr using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists zuw_kopf_schutz on tco.zuw_kopf;
create trigger zuw_kopf_schutz before update or delete on tco.zuw_kopf for each row execute function tco.zuw_kopf_schutz();

create or replace function tco.zuw_pos_schutz() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Positionen einer Zuwendungsbestätigung können nicht gelöscht werden (%).', old.zbnr using errcode = 'P0001';
  end if;
  if (new.zbnr, new.lfd, new.internenr, new.konto, new.posnr, new.datum, new.betrag, new.art_text, new.verzicht, new.text)
     is distinct from (old.zbnr, old.lfd, old.internenr, old.konto, old.posnr, old.datum, old.betrag, old.art_text, old.verzicht, old.text)
     or (new.aktiv and not old.aktiv) then
    raise exception 'Positionen einer Zuwendungsbestätigung können nicht geändert werden (%).', old.zbnr using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists zuw_pos_schutz on tco.zuw_pos;
create trigger zuw_pos_schutz before update or delete on tco.zuw_pos for each row execute function tco.zuw_pos_schutz();
