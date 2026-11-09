-- Erlöskonto je Produkt: Zahlungen auf Hallenrechnungen werden beim Buchen nach den Positionen
-- auf die Erlöskonten aufgeteilt (Splitbuchung). Leer = Hallenmiete 8003.
alter table tco.produkte add column if not exists erloeskonto text;
