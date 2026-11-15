-- LSVS-Bestandsmeldung (DOSB-Schnittstelle „SV-LSB“): Angaben für den Kopf der XML-Datei
--   lsvs_vereinsnr        Nummer des Vereins beim Landessportverband (Vereinskennziffer, auch Benutzername im LSVSnet)
--   lsvs_ansprechpartner  Ansprechpartner für Rückfragen des LSVS
--   lsvs_fachverband      Code des Fachverbands für die B-Meldung (DOSB-Funktionscodes: Tennis = 83)
--   lsvs_schluessel       Bezeichnung der Software, mit der die Datei erstellt wurde
alter table tco.verein add column if not exists lsvs_vereinsnr text;
alter table tco.verein add column if not exists lsvs_ansprechpartner text not null default 'Torsten Laub';
alter table tco.verein add column if not exists lsvs_fachverband text not null default '83';
alter table tco.verein add column if not exists lsvs_schluessel text not null default 'linear';
