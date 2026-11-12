-- Instandhaltung (#205, Nachtrag): „Wo“ mit Gruppen, Matrix Kategorie × Ort, Zuständigkeit je Benutzer für Orte und/oder
-- Kategorien, Protokoll mit Benutzer und Aktion, Formular (PDF) in Paperless.

-- Wo: Gruppe für die Auswahl (z. B. Außenplätze, Tennishalle, Clubhaus)
alter table tco.ih_anlage add column if not exists gruppe text not null default '';
update tco.ih_anlage set gruppe = case typ when 'PLATZ' then 'Außenplätze' when 'HALLE' then 'Tennishalle' when 'GEBAEUDE' then 'Clubhaus'
                                           when 'AUSSEN' then 'Außenanlage' else 'Sonstiges' end
 where gruppe = '';

-- Matrix: welche Kategorie an welchem Ort gemeldet werden kann (Vorbelegung: alle)
create table if not exists tco.ih_anlage_kategorie (
  anlage_id    int not null references tco.ih_anlage (id) on delete cascade,
  kategorie_id int not null references tco.ih_kategorie (id) on delete cascade,
  primary key (anlage_id, kategorie_id)
);
insert into tco.ih_anlage_kategorie (anlage_id, kategorie_id)
select a.id, k.id from tco.ih_anlage a cross join tco.ih_kategorie k
on conflict do nothing;
select core.enable_audit('tco.ih_anlage_kategorie', 'IH_MATRIX', 'anlage_id,kategorie_id');

-- Zuständigkeit: Benutzer für einen Ort, eine Kategorie oder beides (spezifischer gewinnt)
create table if not exists tco.ih_zustaendig (
  id           serial primary key,
  benutzer_id  uuid not null references core.users (id) on delete cascade,
  anlage_id    int  references tco.ih_anlage (id) on delete cascade,
  kategorie_id int  references tco.ih_kategorie (id) on delete cascade,
  check (anlage_id is not null or kategorie_id is not null)
);
create unique index if not exists ih_zustaendig_uq on tco.ih_zustaendig (benutzer_id, anlage_id, kategorie_id) nulls not distinct;
insert into tco.ih_zustaendig (benutzer_id, kategorie_id)
select zustaendig, id from tco.ih_kategorie where zustaendig is not null
on conflict do nothing;
alter table tco.ih_kategorie drop column if exists zustaendig;
select core.enable_audit('tco.ih_zustaendig', 'IH_ZUSTAENDIG', 'id');

-- Protokoll: jeder Schritt mit Zeitstempel, Benutzer und Aktion
alter table tco.ih_verlauf add column if not exists benutzer_id uuid references core.users (id) on delete set null;
alter table tco.ih_verlauf add column if not exists aktion text not null default 'KOMMENTAR';
update tco.ih_verlauf set aktion = case when text = 'Schaden gemeldet' then 'ANGELEGT' when status is not null then 'STATUS'
                                        when text like '%gesperrt' then 'SPERRE' when text like 'Sperre %' then 'SPERRE_AUF'
                                        when von = 'system' then 'ERINNERUNG' else 'KOMMENTAR' end;

-- Formular in Paperless (Abschluss / Weitergabe)
alter table tco.ih_meldung add column if not exists formular_doc_id int;
alter table tco.ih_meldung add column if not exists formular_am timestamptz;
