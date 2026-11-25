-- Änderungen der Mitgliedschaft aus „Meine Mitgliedschaft“ (Beitragswechsel, Jugendtraining) mit Freigabe durch den Vorstand:
-- Das Mitglied reicht ein (OFFEN) – an Verträgen ändert sich noch nichts, der Vorstand wird informiert (Arbeitsvorrat, Push).
-- Erst die Freigabe führt die Änderung aus, mit den beim Einreichen festgelegten Terminen; danach geht die
-- Mitgliederinformation per E-Mail an das Mitglied (ABGESCHLOSSEN). Ging die E-Mail nicht hinaus, bleibt sie FREIGEGEBEN.
-- Abgelehnte Anträge bleiben mit Begründung stehen (ABGELEHNT), das Mitglied erhält den Grund per E-Mail.
create table if not exists tco.mg_aenderungen (
  id             bigserial primary key,
  typ            text not null check (typ in ('BEITRAGSWECHSEL', 'JUGENDTRAINING')),
  adrnr          text not null references tco.mitglieder(adrnr),   -- Person, deren Vertrag sich ändert
  antragsteller  text not null references tco.mitglieder(adrnr),   -- angemeldetes Mitglied
  mail_an        text not null,                                    -- Mitglied, das die Mitgliederinformation erhält (Zahler)
  benutzer_id    uuid references core.users(id) on delete set null,
  benutzer       text not null,
  vertragnr      text,                                             -- bisheriger Vertrag (Beitragswechsel)
  art            text not null,                                    -- neue Beitragsart bzw. Trainingseinheit
  artname        text not null,
  ab             date not null,                                    -- Wechsel ab bzw. Trainingsbeginn (beim Einreichen festgelegt)
  text           text not null,                                    -- Wortlaut: was ändert sich
  schritte       jsonb not null default '[]',
  eingang        date not null default current_date,
  eingang_am     timestamptz not null default now(),
  status         text not null default 'OFFEN' check (status in ('OFFEN', 'FREIGEGEBEN', 'ABGESCHLOSSEN', 'ABGELEHNT')),
  bearbeitet_am  timestamptz,
  bearbeitet_von text,
  ablehnung      text,
  abgelegt       boolean not null default false,
  gesendet       boolean not null default false,
  abgeschlossen_am timestamptz
);
comment on table tco.mg_aenderungen is 'Beitragswechsel und Jugendtraining aus „Meine Mitgliedschaft“: eingereicht, vom Vorstand freigegeben, Mitgliederinformation gesendet';
create index if not exists mg_aenderungen_status_idx on tco.mg_aenderungen (status);
create index if not exists mg_aenderungen_adrnr_idx on tco.mg_aenderungen (adrnr);
create index if not exists mg_aenderungen_antragsteller_idx on tco.mg_aenderungen (antragsteller);
select core.enable_audit('tco.mg_aenderungen', 'MG_AENDERUNG', 'id', '', 'eingang_am');
