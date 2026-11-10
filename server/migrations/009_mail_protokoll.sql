-- Mailprotokoll des Portals (bisher tco.mail_protokoll): jeder Versuch über den n8n-Mailversand mit Status, Absender und Fehler.
-- nachricht: Inhalt (inkl. Anhänge) bzw. Anleitung zum Neuerzeugen – anfangs nur bei Fehlern, inzwischen bei jeder E-Mail; nie mit Zugangslinks/Kennwörtern;
-- nach 30 Tagen bzw. erfolgreicher Wiederholung geleert. Aufbewahrung 180 Tage.
create table if not exists core.mail_protokoll (
  id            bigserial primary key,
  zeit          timestamptz not null default now(),
  anwendung     text, objekt text, an text, betreff text,
  absender      text,              -- gewünschter Absender (Bearbeiter bzw. Ersatz)
  von           text,              -- tatsächlicher Absender laut n8n
  status        text not null,     -- gesendet | entwurf | fehler | nicht_gesendet
  fehler        text,
  benutzer      text,
  nachricht     jsonb,
  erneut_am     timestamptz,
  erneut_von    text,
  erneut_status text
);
create index if not exists mail_protokoll_zeit_idx on core.mail_protokoll (zeit desc);
