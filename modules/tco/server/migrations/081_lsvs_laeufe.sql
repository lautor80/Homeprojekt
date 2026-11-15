-- LSVS-Bestandsmeldung als eigene App: jeder Lauf hält die bestätigte Übersicht, die erzeugte Austauschdatei
-- und die Ablage des Ausdrucks in Paperless fest (Übersicht der Läufe, erneuter Download, Ausdruck).
create table if not exists tco.lsvs_laeufe (
  id            serial primary key,
  stichtag      date not null,
  erstellt_am   timestamptz not null default now(),
  erstellt_von  text not null,
  bestaetigt    text not null,                 -- Text der Bestätigung, die vor dem Erzeugen angekreuzt wurde
  kopf          jsonb not null,                -- Software, Vereinsnummer, Bezeichnung, Ansprechpartner, Fachverband
  zeilen        jsonb not null,                -- je Jahrgang männlich/weiblich/divers
  summe         jsonb not null,
  hinweise      jsonb not null default '[]',   -- Mitglieder ohne Geburtsdatum/Geschlecht (nicht gemeldet)
  dateiname     text not null,
  xml           text not null,
  paperless_id  int,
  paperless_am  timestamptz
);
create index if not exists lsvs_laeufe_stichtag on tco.lsvs_laeufe (stichtag);
