-- Hallenwart (#11): Klärung mit dem Kunden zu einer Hallenbuchung ohne Hallenschlüssel („Halle aufsperren“) bestätigt.
-- Geklärte Buchungen erscheinen nicht mehr im Arbeitsvorrat.
create table if not exists tco.halle_geklaert (
  bid    text not null,
  datum  date not null,
  am     timestamptz not null default now(),
  von    text,
  primary key (bid, datum)
);
select core.enable_audit('tco.halle_geklaert', 'BUCHUNG', 'bid');
