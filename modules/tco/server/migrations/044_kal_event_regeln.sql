-- Vereinskalender (Issue #16): Regelwerk für die Standardzuordnung von Veranstaltungen zu einer Gruppe –
-- „Text abc in Spalte … => Gruppe“. Die erste passende aktive Regel (nach Reihenfolge) gilt.
create table if not exists tco.kal_event_regeln (
  id        serial primary key,
  feld      text not null check (feld in ('titel', 'beschreibung', 'ort')),
  text      text not null check (length(trim(text)) > 0),
  gruppe_id int not null references tco.kal_gruppen(id) on delete cascade,
  aktiv     boolean not null default true
);
select core.enable_audit('tco.kal_event_regeln', 'KAL_GRUPPE', 'gruppe_id');
