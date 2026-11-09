-- Regelwerk der Mitgliedergruppen (Issue #16): Regeln ordnen Mitglieder nach Alter einer Gruppe zu
-- (z. B. Kleinfeld 6–7 Jahre). „jahrgang“ = das Kalenderjahr zählt ganz, in dem das Alter erreicht wird bzw. noch erreicht war.
-- „andere_entfernen“ = wer nicht (mehr) passt, wird aus der Gruppe entfernt – auch von Hand Zugeordnete.
create table if not exists tco.kal_gruppen_regeln (
  id               serial primary key,
  gruppe_id        int not null references tco.kal_gruppen(id) on delete cascade,
  alter_von        int,
  alter_bis        int,
  jahrgang         boolean not null default false,
  andere_entfernen boolean not null default false,
  aktiv            boolean not null default true,
  check (alter_von is not null or alter_bis is not null),
  check (alter_von is null or alter_bis is null or alter_von <= alter_bis)
);
create index if not exists kal_gruppen_regeln_gruppe_idx on tco.kal_gruppen_regeln (gruppe_id);
select core.enable_audit('tco.kal_gruppen_regeln', 'KAL_GRUPPE', 'gruppe_id');

-- Zuordnung stammt aus dem Regelwerk: nur solche Zuordnungen nimmt das Regelwerk von sich aus wieder zurück
alter table tco.kal_gruppe_mitglieder add column if not exists regel boolean not null default false;
