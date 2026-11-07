-- Beispielmodul: eigenes Schema je Modul
create schema if not exists beispiel;

create table beispiel.kontakte (
  id          uuid primary key default gen_random_uuid(),
  nummer      text not null unique,            -- aus Nummernkreis KONTAKT, z. B. K000001
  name        text not null,
  firma       text,
  email       text,
  telefon     text,
  notiz       text,
  aktiv       boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create trigger kontakte_touch before update on beispiel.kontakte
  for each row execute function core.touch_updated_at();

-- Änderungsbelege einschalten: Objekttyp KONTAKT, Schlüssel = nummer,
-- keine maskierten Felder, technische Felder werden nicht protokolliert
select core.enable_audit('beispiel.kontakte', 'KONTAKT', 'nummer', '', 'id,created_at,updated_at');
