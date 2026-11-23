-- Rechnung zur Korrektur öffnen: Ein fakturierter Auftrag (bei einer Sammelrechnung alle ihre Aufträge) wird wieder bearbeitbar.
-- Die Rechnungsnummer und das Rechnungsdatum werden hier vorgemerkt und beim erneuten Erzeugen unverändert wieder vergeben.
-- Der Vermerk erklärt die Änderung und steht – mit dem Datum der Korrektur – auf der neu gedruckten Rechnung.
alter table transport.auftraege add column if not exists faktura_reserviert       text;
alter table transport.auftraege add column if not exists fakturadatum_reserviert  date;
alter table transport.auftraege add column if not exists rechnung_vermerk         text;
alter table transport.auftraege add column if not exists rechnung_korrigiert_am   date;
create index if not exists auftraege_faktura_reserviert_idx on transport.auftraege (faktura_reserviert) where faktura_reserviert is not null;
