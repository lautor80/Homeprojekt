-- #12: Vertragsangebot – vorbelegter Mitgliedsantrag per E-Mail-Link (Token nur als Hash, befristet, einmalig)
create table if not exists tco.vertragsangebote (
  id            bigserial primary key,
  nummer        text not null unique,                 -- VA-JJJJ-NNNN
  token_hash    text not null unique,
  status        text not null default 'OFFEN' check (status in ('OFFEN', 'ANGENOMMEN', 'ZURUECKGEZOGEN')),
  daten         jsonb not null,                       -- Personen (adrnr optional), Anschrift, Kontakt, Eintritt, Verträge
  email         text not null,                        -- Empfänger des Links
  gueltig_bis   date not null,
  erstellt_am   timestamptz not null default now(),
  erstellt_von  text,
  geoeffnet_am  timestamptz,
  versuche      int not null default 0,               -- falsche Geburtsdaten beim Öffnen
  antrag        text                                  -- Nummer des Mitgliedsantrags nach der Annahme
);
create index if not exists vertragsangebote_status_idx on tco.vertragsangebote (status, erstellt_am);
select core.enable_audit('tco.vertragsangebote', 'VERTRAGSANGEBOT', 'id', 'token_hash', 'geoeffnet_am,versuche');
