-- Online-Mitgliedsantrag (#12): öffentliches Formular /beitritt (auch Familienanträge) mit SEPA-Mandat.
-- Ein Antrag wird nie automatisch Mitglied: Prüfung und Übernahme durch den Vorstand/Kassenwart.
create table if not exists tco.mitgliedsantraege (
  id            bigserial primary key,
  nummer        text not null unique,                 -- MA-JJJJ-NNNN
  status        text not null default 'EINGANG' check (status in ('EINGANG', 'UEBERNOMMEN', 'ABGELEHNT')),
  eingang       timestamptz not null default now(),
  daten         jsonb not null,                       -- Personen, Anschrift, Kontakt, Eintritt, Zustimmungen
  kontoinhaber  text, iban text, bic text, bank text,  -- Bankdaten getrennt (Schutz wie im Mitgliederstamm)
  sepa_am       timestamptz,                          -- Zeitpunkt der online erteilten Einzugsermächtigung
  ip            text,
  bearbeitet_am timestamptz, bearbeitet_von text, bemerkung text,
  ergebnis      jsonb                                 -- angelegte Mitglieder/Benutzer
);
create index if not exists mitgliedsantraege_status_idx on tco.mitgliedsantraege (status, eingang);
select core.enable_audit('tco.mitgliedsantraege', 'MITGLIEDSANTRAG', 'id', '', 'eingang,ip');
