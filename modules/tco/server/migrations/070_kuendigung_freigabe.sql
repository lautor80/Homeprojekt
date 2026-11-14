-- Kündigung durch das Mitglied mit Freigabe (#232): „Meine Mitgliedschaft“ ändert nichts mehr sofort. Die Kündigung wird
-- eingereicht (OFFEN) und steht im Arbeitsvorrat des Vorstands. Erst die Freigabe führt sie aus – mit dem Tag des Eingangs
-- als Kündigungsdatum (FREIGEGEBEN); die Kündigungsbestätigung wird erzeugt, geprüft und an das Mitglied gesendet
-- (ABGESCHLOSSEN). Abgelehnte Kündigungen bleiben mit Begründung stehen (ABGELEHNT).
create table if not exists tco.kuendigungen (
  id             bigserial primary key,
  adrnr          text not null references tco.mitglieder(adrnr),   -- Mitglied, das kündigt
  benutzer_id    uuid references core.users(id) on delete set null,
  benutzer       text not null,
  art            text not null check (art in ('MITGLIEDSCHAFT', 'VERTRAG')),
  vertraege      jsonb not null default '[]',                      -- [{ adrnr, vertragnr }] bei art = VERTRAG
  mehrfach       boolean not null default false,                   -- aus der Mehrfachauswahl (eigener Mitgliedsbeitrag dabei = Austritt)
  grund          text,
  eingang        date not null default current_date,               -- Kündigungsdatum: danach richten sich die Fristen
  eingang_am     timestamptz not null default now(),
  status         text not null default 'OFFEN' check (status in ('OFFEN', 'FREIGEGEBEN', 'ABGESCHLOSSEN', 'ABGELEHNT')),
  text           text not null,                                    -- Wortlaut: was endet wann
  betroffen      text not null,                                    -- Mitglied, auf das die Kündigungsbestätigung lautet
  ende           date,
  bearbeitet_am  timestamptz,
  bearbeitet_von text,
  ablehnung      text,
  abgelegt       boolean not null default false,                   -- Bestätigung liegt in der Mitgliederakte (Paperless)
  gesendet       boolean not null default false,                   -- Bestätigung per E-Mail an das Mitglied gesendet
  abgeschlossen_am timestamptz
);
comment on table tco.kuendigungen is 'Kündigungen aus „Meine Mitgliedschaft“: eingereicht, vom Vorstand freigegeben, Bestätigung gesendet';
create index if not exists kuendigungen_status_idx on tco.kuendigungen (status);
create index if not exists kuendigungen_adrnr_idx on tco.kuendigungen (adrnr);
select core.enable_audit('tco.kuendigungen', 'KUENDIGUNG', 'id', '', 'eingang_am');
