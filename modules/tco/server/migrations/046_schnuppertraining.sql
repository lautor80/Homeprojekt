-- Schnuppertraining (#86): öffentliche Anmeldung /schnuppertraining. Die Person steht im Mitgliederstamm (tco.mitglieder,
-- ohne Mitgliedsnummer und Eintritt) mit der Kategorie „Schnuppertraining“; die Angaben zum Schnuppern stehen hier.
-- Beim Beitritt (Übernahme des Mitgliedsantrags) wird derselbe Stammsatz zum Mitglied, der Status wechselt auf MITGLIED.
create table if not exists tco.schnupper (
  adrnr          text primary key,                    -- Stammsatz in tco.mitglieder
  nummer         text not null unique,                -- ST-JJJJ-NNNN
  status         text not null default 'NEU'
                 check (status in ('NEU', 'KONTAKTIERT', 'TERMIN', 'ABSOLVIERT', 'MITGLIED', 'ABGESAGT')),
  eingang        timestamptz not null default now(),
  alter_jahre    int,
  gespielt       boolean not null default false,      -- schon Tennis gespielt
  stufe          text not null default 'NEU' check (stufe in ('NEU', 'ANFAENGER', 'FORTGESCHRITTEN')),
  termine        jsonb not null default '{}',         -- { tage: ['Mo', …], zeiten: ['vormittags', …], text }
  erziehungsberechtigt text,
  mitteilung     text,
  einwilligung_am timestamptz,                         -- Einwilligung: Kontaktdaten nur zur Kontaktaufnahme
  einheit1       date, einheit2 date,                 -- absolvierte (kostenlose) Einheiten
  trainer        text,                                -- zuständiger Vereinstrainer
  notiz          text,
  token          text not null unique default replace(gen_random_uuid()::text, '-', ''),  -- Beitrittslink /beitritt?schnupper=
  antrag         text,                                -- Nummer des Mitgliedsantrags beim Beitritt
  bearbeitet_am  timestamptz, bearbeitet_von text,
  ip             text
);
create index if not exists schnupper_status_idx on tco.schnupper (status, eingang);
-- Änderungsbelege beim Mitglied (gleicher Schlüssel), Token nicht protokollieren
select core.enable_audit('tco.schnupper', 'MITGLIED', 'adrnr', 'token', 'eingang,ip,bearbeitet_am,bearbeitet_von');
