-- Mitgliedergruppen als Baum (Issue #33): Die Gruppen des Vereinskalenders (Mannschaften) werden zur allgemeinen
-- Gruppierung der Mitglieder. Eine Gruppe kann unter einer anderen hängen (Kategorie → Gruppe → Mannschaft),
-- ein Mitglied kann beliebig vielen Gruppen angehören (tco.kal_gruppe_mitglieder, unverändert).
alter table tco.kal_gruppen add column if not exists parent_id int references tco.kal_gruppen(id) on delete restrict;
alter table tco.kal_gruppen drop constraint if exists kal_gruppen_parent_chk;
alter table tco.kal_gruppen add constraint kal_gruppen_parent_chk check (parent_id is null or parent_id <> id);

-- Der Name muss nur noch innerhalb derselben Ebene eindeutig sein (z. B. „Herren 40“ unter Mannschaften und unter Training)
alter table tco.kal_gruppen drop constraint if exists kal_gruppen_name_key;
create unique index if not exists kal_gruppen_ebene_name_uq on tco.kal_gruppen (coalesce(parent_id, 0), lower(name));
create index if not exists kal_gruppen_parent_idx on tco.kal_gruppen (parent_id);
create index if not exists kal_gruppe_mitglieder_adrnr_idx on tco.kal_gruppe_mitglieder (adrnr);
