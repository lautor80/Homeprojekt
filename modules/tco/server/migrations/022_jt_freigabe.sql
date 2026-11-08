-- Freigabe des Zeitnachweises Jugendtraining durch den Trainer (Monatsabschluss in „Meine Trainingszeiten“).
-- Mit der Freigabe ist der Monat für den Trainer gesperrt; die Jugendleitung kann sie zurücknehmen.
alter table tco.jt_doku add column if not exists freigegeben_am timestamptz;
alter table tco.jt_doku add column if not exists freigegeben_von text;
