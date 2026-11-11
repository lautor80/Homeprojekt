-- #121: ohne MwSt muss der Grund gewählt werden – Reverse Charge oder umsatzsteuerfreier Transport in ein Drittland
-- (§ 4 Nr. 3 Buchst. a Unterbuchst. aa UStG). Leer = bisherige Ableitung aus dem Land des Rechnungsempfängers.
alter table transport.auftraege add column if not exists steuerbefreiung text
  check (steuerbefreiung is null or steuerbefreiung in ('RC', 'DRITTLAND'));
