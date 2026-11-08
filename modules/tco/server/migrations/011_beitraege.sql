-- Beitragsstamm (Port von ZCL_TCO_BEITRAG / Z2UI5_CL_TCO_BEITRAEGE)
-- Die Zeiträume in tco.beitrag_pr sind lückenlos, der letzte ist offen bis 31.12.9999 (wie in SAP).
-- Aus der Übernahme können offene Zeiträume ohne Bis-Datum stammen: angleichen, damit die Prüfungen
-- (lückenlos, offenes Ende) greifen. Lesende Stellen behandeln NULL weiterhin als offen.
update tco.beitrag_pr set gueltig_bis = '9999-12-31' where gueltig_bis is null;
alter table tco.beitrag_pr alter column gueltig_bis set default '9999-12-31';

-- Zugriffe je Beitragsart (laufende Verträge je Art, Forecast)
create index if not exists vertraege_art_idx on tco.vertraege (art);
create index if not exists vertraege_laufzeit_idx on tco.vertraege (vertragbegin, vertragende);
