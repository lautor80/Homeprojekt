-- Turniere (Sport → Turniere): KO-Turnier mit Nebenrunde, Monats-Gruppenliga, Doppel-/Mixed-Spaßturnier.
-- Öffentliche Anmeldung (/turnier?t=<kennung>), Live-Ansicht (/turnier-live?t=<kennung>) und persönlicher Link je
-- Teilnehmer (/turnier-mein?z=<schlüssel>, nur der Hash wird gespeichert) zum Eintragen eigener Ergebnisse.

create table tco.turniere (
  id              serial primary key,
  kennung         text not null unique check (kennung ~ '^[a-z0-9][a-z0-9-]{1,59}$'),  -- in den öffentlichen Links
  name            text not null,
  modus           text not null check (modus in ('ko', 'liga', 'spass')),
  status          text not null default 'entwurf' check (status in ('entwurf', 'anmeldung', 'laeuft', 'beendet')),
  beschreibung    text,
  meldeschluss    date,
  max_teilnehmer  integer check (max_teilnehmer is null or max_teilnehmer between 2 and 256),
  -- Einstellungen je Modus (siehe modules/tco/server/turnier/typen.ts → KoEinstellungen, LigaEinstellungen, SpassEinstellungen)
  einstellungen   jsonb not null default '{}'::jsonb,
  -- Schlüssel für die Ergebniseingabe am Platz (Spaßturnier, QR-Code); nur der Hash
  platz_hash      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create trigger turniere_touch before update on tco.turniere for each row execute function core.touch_updated_at();
select core.enable_audit('tco.turniere', 'TURNIER', 'id', 'platz_hash', 'created_at,updated_at');

-- Teilnehmende: Mitglied (adrnr) oder Gast; Stärke = LK (kleiner ist stärker) oder manueller Rang (1 = stärkste/r)
create table tco.turnier_teilnehmer (
  id              serial primary key,
  turnier_id      integer not null references tco.turniere(id) on delete cascade,
  vorname         text not null,
  nachname        text not null,
  geburtsjahr     integer check (geburtsjahr is null or geburtsjahr between 1900 and 2100),
  geschlecht      text check (geschlecht is null or geschlecht in ('w', 'm', 'd')),
  email           text,
  telefon         text,
  adrnr           text,                                  -- Mitglied (tco.mitgliedera), sonst Gast
  lk              numeric(4,1) check (lk is null or lk between 1 and 25),
  rang            integer check (rang is null or rang > 0),  -- manuelle Stärke (überstimmt die LK in der Rangliste)
  setzplatz       integer check (setzplatz is null or setzplatz > 0),  -- KO: Setzplatz 1, 2, …
  status          text not null default 'gemeldet' check (status in ('gemeldet', 'warteliste', 'abgemeldet')),
  zugang_hash     text unique,                           -- persönlicher Link (sha256 des Schlüssels)
  bemerkung       text,
  angemeldet_am   timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index on tco.turnier_teilnehmer (turnier_id);
create trigger turnier_teilnehmer_touch before update on tco.turnier_teilnehmer for each row execute function core.touch_updated_at();
select core.enable_audit('tco.turnier_teilnehmer', 'TURNIER', 'turnier_id', 'zugang_hash', 'angemeldet_am,updated_at');

-- Runden: Liga = ein Kalendermonat (monat = 1. des Monats), Spaßturnier = eine Zeitrunde (beginn/minuten), KO = nicht benötigt
create table tco.turnier_runden (
  id          serial primary key,
  turnier_id  integer not null references tco.turniere(id) on delete cascade,
  nr          integer not null check (nr > 0),
  monat       date check (monat is null or extract(day from monat) = 1),
  beginn      timestamptz,
  minuten     integer check (minuten is null or minuten between 1 and 240),
  status      text not null default 'geplant' check (status in ('geplant', 'laeuft', 'abgeschlossen')),
  unique (turnier_id, nr)
);
select core.enable_audit('tco.turnier_runden', 'TURNIER', 'turnier_id');

-- Einteilung je Runde: Liga = Gruppe und Position darin, Spaßturnier = Pause (gewünscht oder zugelost)
create table tco.turnier_einteilung (
  runde_id          integer not null references tco.turnier_runden(id) on delete cascade,
  teilnehmer_id     integer not null references tco.turnier_teilnehmer(id) on delete cascade,
  gruppe            integer,
  pos               integer not null default 0,
  pause             boolean not null default false,
  pause_gewuenscht  boolean not null default false,
  primary key (runde_id, teilnehmer_id)
);
select core.enable_audit('tco.turnier_einteilung', 'TURNIER', 'runde_id,teilnehmer_id');

-- Spiele aller Modi. a/b = Teilnehmer-IDs je Seite (Einzel: eine, Doppel: zwei; leer = Freilos/noch offen).
-- feld: KO 'haupt' | 'neben', Liga 'gruppe', Spaßturnier 'runde'. runde = KO-Runde (1 = erste) bzw. Rundennummer.
-- saetze: [[6,4],[3,6],[10,8]] (Tennis) – beim Spaßturnier [[spieleA, spieleB]].
-- wertung: offen | gespielt | aufgabe | wo (kampflos, sieger gesetzt) | keine (Liga: keiner bekommt etwas) | freilos
create table tco.turnier_spiele (
  id               serial primary key,
  turnier_id       integer not null references tco.turniere(id) on delete cascade,
  runde_id         integer references tco.turnier_runden(id) on delete cascade,
  feld             text not null default 'haupt' check (feld in ('haupt', 'neben', 'gruppe', 'runde')),
  runde            integer not null default 1,
  pos              integer not null default 0,
  gruppe           integer,
  platz            integer,
  a                integer[] not null default '{}',
  b                integer[] not null default '{}',
  saetze           jsonb,
  wertung          text not null default 'offen' check (wertung in ('offen', 'gespielt', 'aufgabe', 'wo', 'keine', 'freilos')),
  sieger           text check (sieger is null or sieger in ('a', 'b', 'x')),  -- x = unentschieden (nur Spaßturnier)
  bemueht          text check (bemueht is null or bemueht in ('a', 'b')),     -- Liga: wer sich um einen Termin bemüht hat
  eingetragen_von  text,
  eingetragen_am   timestamptz
);
create index on tco.turnier_spiele (turnier_id, feld, runde);
select core.enable_audit('tco.turnier_spiele', 'TURNIER', 'turnier_id', '', 'eingetragen_am');
