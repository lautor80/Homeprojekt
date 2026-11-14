-- Platzverwaltung: einzelne Termine fester Belegungen (Training, Veranstaltung, Sperrzeit) nachträglich absagen.
-- Der Termin gibt den Platz frei und zählt nicht mehr in die Belegungsquote. Aus EP3 übernommene Belegungen werden bei
-- jedem Import neu angelegt (neue id) – die Absage hängt deshalb an einem stabilen Schlüssel:
--   'EP3:<ext_id>' für EP3-Events, sonst die id der Belegung.
create table if not exists tco.platzbelegung_ausfall (
  schluessel  text not null,
  platz_id    int  not null,
  datum       date not null,
  grund       text,
  angelegt_am timestamptz not null default now(),
  angelegt_von text,
  primary key (schluessel, platz_id, datum)
);
select core.enable_audit('tco.platzbelegung_ausfall', 'PLATZ_AUSFALL', 'schluessel,platz_id,datum');

-- EP3 gibt es nicht mehr: aus EP3 übernommene Buchungen ändert die Platzverwaltung selbst. Geänderte Termine merkt sich
-- das Portal, damit ein (versehentlicher) erneuter EP3-Import sie nicht zurücksetzt.
alter table tco.bookings add column if not exists portal_geaendert timestamptz;
