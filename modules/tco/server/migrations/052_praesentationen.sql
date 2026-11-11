-- #146: App „Präsentationen“ – eigene PowerPoint-Vorlagen (Option B) und Sammelkorb je Benutzer (Option C)
create table if not exists tco.praesentation_vorlagen (
  id           serial primary key,
  name         text not null,
  beschreibung text,
  dateiname    text not null,
  datei        bytea not null,
  platzhalter  jsonb not null default '[]',
  angelegt_am  timestamptz not null default now(),
  angelegt_von text default nullif(current_setting('app.username', true), '')
);
select core.enable_audit('tco.praesentation_vorlagen', 'PRAESENTATION_VORLAGE', 'id', '', 'datei');

create table if not exists tco.praesentation_korb (
  user_id      uuid primary key references core.users(id) on delete cascade,
  eintraege    jsonb not null default '[]',
  geaendert_am timestamptz not null default now()
);

-- Wer die Vereinsübersicht sieht, darf Präsentationen erstellen (Vorlagen pflegen: nur Administratoren bzw. per Rollenpflege)
insert into core.role_permissions (role_id, permission)
select distinct role_id, 'tco.praesentation:display' from core.role_permissions where permission = 'tco.dashboard:display'
on conflict do nothing;
