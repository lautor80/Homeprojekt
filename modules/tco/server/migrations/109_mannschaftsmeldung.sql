-- Mannschaftsmeldung / Anmeldematrix: Der Sportwart legt je Saison eine Abfrage mit den Mannschaften (Altersklassen aus den
-- Mitgliedergruppen) an; jedes Mitglied – auch für seine Familie – gibt je Mannschaft 1 = fest, 2 = Ersatz, 3 = nicht an.

create table tco.mm_abfragen (
  id          serial primary key,
  titel       text not null,
  saison      text not null default '',
  -- bis einschließlich dieses Tages können Mitglieder antworten; leer = ohne Frist
  frist       date,
  hinweis     text not null default '',
  status      text not null default 'entwurf' check (status in ('entwurf', 'offen', 'geschlossen')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create trigger mm_abfragen_touch before update on tco.mm_abfragen for each row execute function core.touch_updated_at();
select core.enable_audit('tco.mm_abfragen', 'MANNSCHAFTSMELDUNG', 'id', '', 'created_at,updated_at');

-- Mannschaften der Abfrage (Spalten der Matrix); Name und Pfad kommen aus der Gruppe
create table tco.mm_mannschaften (
  abfrage_id  integer not null references tco.mm_abfragen(id) on delete cascade,
  gruppe_id   integer not null references tco.kal_gruppen(id) on delete cascade,
  position    integer not null,
  primary key (abfrage_id, gruppe_id)
);
select core.enable_audit('tco.mm_mannschaften', 'MANNSCHAFTSMELDUNG', 'abfrage_id,gruppe_id');

create table tco.mm_antworten (
  abfrage_id    integer not null,
  gruppe_id     integer not null,
  adrnr         text not null,
  wahl          smallint not null check (wahl in (1, 2, 3)),
  geaendert_am  timestamptz not null default now(),
  geaendert_von text not null default '',
  primary key (abfrage_id, gruppe_id, adrnr),
  foreign key (abfrage_id, gruppe_id) references tco.mm_mannschaften (abfrage_id, gruppe_id) on delete cascade
);
create index mm_antworten_adrnr on tco.mm_antworten (adrnr);
select core.enable_audit('tco.mm_antworten', 'MANNSCHAFTSMELDUNG', 'abfrage_id,adrnr,gruppe_id', '', 'geaendert_am');

-- Bemerkung je Person (z. B. „ab Juni verfügbar“)
create table tco.mm_bemerkungen (
  abfrage_id  integer not null references tco.mm_abfragen(id) on delete cascade,
  adrnr       text not null,
  text        text not null,
  primary key (abfrage_id, adrnr)
);
select core.enable_audit('tco.mm_bemerkungen', 'MANNSCHAFTSMELDUNG', 'abfrage_id,adrnr');

-- Rechte: Mitglieder melden sich selbst (Rolle „Mitglied“ und jede Rolle mit „Meine Daten“); der Sportwart und wer
-- Spielerdaten pflegt, sieht und pflegt die Anmeldematrix
insert into core.role_permissions (role_id, permission)
select id, 'tco.mannschaftsmeldung:melden' from core.roles where id = 'MITGLIED'
union
select role_id, 'tco.mannschaftsmeldung:melden' from core.role_permissions where permission = 'tco.meinedaten:edit'
on conflict do nothing;
insert into core.role_permissions (role_id, permission)
select distinct role_id, p from core.role_permissions, (values ('tco.anmeldematrix:display'), ('tco.anmeldematrix:edit')) as x(p)
 where permission = 'tco.sport:edit'
on conflict do nothing;
