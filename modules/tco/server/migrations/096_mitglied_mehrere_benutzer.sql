-- Ein Mitglied kann mehreren Benutzern zugeordnet sein (z. B. eigener Zugang und Zugang der Eltern, alter und neuer Zugang).
-- Je Benutzer bleibt es bei höchstens einem Mitglied. Bisher stand der Benutzer in tco.mitgliedera.benutzer_id (je Mitglied einer);
-- die Zuordnungen werden übernommen, die Spalte entfällt.
create table if not exists tco.mitglied_benutzer (
  benutzer_id uuid primary key references core.users (id) on delete cascade,
  adrnr       text not null references tco.mitgliedera (adrnr) on delete cascade,
  angelegt_am timestamptz not null default now()
);
create index if not exists mitglied_benutzer_adrnr on tco.mitglied_benutzer (adrnr);
select core.enable_audit('tco.mitglied_benutzer', 'MITGLIED', 'adrnr', '', 'angelegt_am');

do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'tco' and table_name = 'mitgliedera' and column_name = 'benutzer_id') then
    insert into tco.mitglied_benutzer (benutzer_id, adrnr)
    select benutzer_id, adrnr from tco.mitgliedera where benutzer_id is not null
    on conflict (benutzer_id) do nothing;
    drop index if exists tco.mitgliedera_benutzer_uq;
    alter table tco.mitgliedera drop column benutzer_id;
  end if;
end $$;
