-- Einladung zum Vereinsportal (#10): persönlicher Link/QR-Code für Mitglieder ohne Benutzer (Sammellauf per E-Mail oder Brief)
-- bzw. Schnellweg bei der Registrierung (E-Mail + Geburtsdatum passen zu genau einem Mitglied). Wer den Link einlöst,
-- erhält sofort einen Benutzer mit Rolle MITGLIED – ohne Freigabe, weil der Link nur an die beim Verein hinterlegte Adresse geht.
create table if not exists tco.einladungen (
  id           bigserial primary key,
  adrnr        text not null,
  token_hash   text not null unique,
  weg          text not null check (weg in ('MAIL', 'BRIEF', 'REGISTRIERUNG')),
  gueltig_bis  timestamptz not null,
  erstellt     timestamptz not null default now(),
  erstellt_von text,
  verwendet_am timestamptz,
  benutzer_id  uuid references core.users(id) on delete set null
);
create index if not exists einladungen_adrnr_idx on tco.einladungen (adrnr, erstellt desc);
select core.enable_audit('tco.einladungen', 'EINLADUNG', 'id', 'token_hash', 'erstellt');
