-- Paperless je Bereich (#232, S5): Euroflex liest künftig die eigene Anbindung „transport.paperless“; der bisherige
-- gemeinsame Zugang „paperless“ gehört TC Oberthal. Gibt es in dieser Installation keinen Verein (nur Euroflex), war der
-- gemeinsame Zugang der von Euroflex – dann zieht er um, damit die Ablage ohne Zutun weiterläuft.
-- Mit Verein bleibt „paperless“ beim Verein, und Euroflex ist „nicht eingerichtet“, bis sein eigenes Paperless eingetragen ist.
update core.verbindungen set id = 'transport.paperless'
 where id = 'paperless' and to_regclass('tco.verein') is null
   and not exists (select 1 from core.verbindungen where id = 'transport.paperless');
