-- Bankleitzahlen-Verzeichnis (Datei der Deutschen Bundesbank) für die Ermittlung von BIC und Kreditinstitut aus der IBAN.
-- Öffentliche Daten ohne Personenbezug; wird über „Bankleitzahlendatei laden“ in der Bankverbindung gefüllt und ersetzt.
create table if not exists tco.bankleitzahlen (
  blz          text primary key,
  bic          text,
  name         text not null,
  ort          text,
  importiert_am timestamptz not null default now()
);
