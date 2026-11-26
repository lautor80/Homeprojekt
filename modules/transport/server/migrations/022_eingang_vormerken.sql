-- Posteingang (Reiter „Posteingang“): E-Mails werden je E-Mail bearbeitet (Auftrag, Dateien) und nur vorgemerkt; abgelegt wird
-- gesammelt mit „Übergeben“. vorgemerkt_dokumente = gewählte Dokument-IDs (null = alle offenen).
alter table transport.eing_vorgaenge add column if not exists vorgemerkt_am timestamptz;
alter table transport.eing_vorgaenge add column if not exists vorgemerkt_von text;
alter table transport.eing_vorgaenge add column if not exists vorgemerkt_dokumente jsonb;
