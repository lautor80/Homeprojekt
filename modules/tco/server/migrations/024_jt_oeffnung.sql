-- Meine Trainingszeiten: Trainer bittet den Kassenwart, einen freigegebenen Monat wieder zu öffnen.
alter table tco.jt_doku add column if not exists oeffnung_angefragt_am timestamptz;
alter table tco.jt_doku add column if not exists oeffnung_grund text;
