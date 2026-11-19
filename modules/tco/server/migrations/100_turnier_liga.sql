-- Monats-Gruppenliga: „bemüht“ auch für beide Seiten (beide haben sich um einen Termin bemüht → beim Monatsabschluss keine Wertung)
alter table tco.turnier_spiele drop constraint if exists turnier_spiele_bemueht_check;
alter table tco.turnier_spiele add constraint turnier_spiele_bemueht_check check (bemueht is null or bemueht in ('a', 'b', 'beide'));
