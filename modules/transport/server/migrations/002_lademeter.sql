-- Lademeter (ZEU_AUFTRAG-LADEMETER) – fehlte in der ersten Version der Übernahme
alter table transport.auftraege add column if not exists lademeter numeric(5,1);
