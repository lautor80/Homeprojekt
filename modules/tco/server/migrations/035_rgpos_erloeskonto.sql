-- Hallenrechnung: Erlöskonto je manueller Position (z. B. Gutschrift, Sonstiges) – leer = Erlöskonto des Produkts
alter table tco.rgpos add column if not exists erloeskonto text;
