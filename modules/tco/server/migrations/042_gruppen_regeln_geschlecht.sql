-- Regelwerk der Mitgliedergruppen (Issue #16): Geschlecht als Kriterium je Regel –
-- '' = alle (gemischte Mannschaften), 'M' = männlich, 'W' = weiblich.
alter table tco.kal_gruppen_regeln add column if not exists geschlecht text not null default '';
alter table tco.kal_gruppen_regeln drop constraint if exists kal_gruppen_regeln_geschlecht_chk;
alter table tco.kal_gruppen_regeln add constraint kal_gruppen_regeln_geschlecht_chk check (geschlecht in ('', 'M', 'W'));
