-- Feste Platzbelegungen ohne Buchung: Jugendtraining, Sperrzeiten, Veranstaltungen.
-- Wiederkehrend (Wochentage im Zeitraum) oder einmalig (datum_von = datum_bis). Leere Platzliste = alle Plätze.
-- Quelle PORTAL = in der Platzverwaltung gepflegt; EP3 = aus den EP3-Events (bs_events) übernommen (Import ersetzt diese).
create table if not exists tco.platzbelegungen (
  id          serial primary key,
  bezeichnung text    not null,
  art         text    not null default 'TRAINING' check (art in ('TRAINING', 'SPERRE', 'VERANSTALTUNG')),
  plaetze     int[]   not null default '{}',
  wochentage  text    not null default '1234567',
  datum_von   date    not null,
  datum_bis   date    not null,
  zeit_von    time    not null,
  zeit_bis    time    not null,                 -- 00:00 = Mitternacht
  hinweis     text,
  aktiv       boolean not null default true,
  quelle      text    not null default 'PORTAL',
  ext_id      text,
  check (datum_bis >= datum_von)
);
create index if not exists platzbelegungen_zeit_idx on tco.platzbelegungen (datum_von, datum_bis) where aktiv;
create unique index if not exists platzbelegungen_ext_uq on tco.platzbelegungen (quelle, ext_id) where ext_id is not null;
select core.enable_audit('tco.platzbelegungen', 'PLATZBELEGUNG', 'id');
