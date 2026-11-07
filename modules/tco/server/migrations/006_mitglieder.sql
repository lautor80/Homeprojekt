-- Mitglieder: Notizen mit Änderungsbeleg, Zugriff über Zahler/Familie
select core.enable_audit('tco.mgnotiz', 'MITGLIED', 'adrnr');
create index if not exists mitglieder_kih_idx on tco.mitglieder (adrnrkih);
create index if not exists vertraege_adrnr_idx on tco.vertraege (adrnr);
