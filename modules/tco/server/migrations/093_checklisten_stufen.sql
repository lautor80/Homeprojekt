-- Checklisten: Schritte in bis zu fünf Stufen (Schritt → Unterschritt → …). Ein Schritt mit Unterschritten ist eine
-- Gruppe: abgehakt werden nur die Schritte ohne Unterschritte, der Stand der Gruppe ergibt sich daraus.
-- Die Tiefe (höchstens 5) prüft der Server; pos gilt je Geschwisterreihe.
alter table tco.cl_schritte add column if not exists parent_id int references tco.cl_schritte (id) on delete cascade;
create index if not exists cl_schritte_parent_idx on tco.cl_schritte (parent_id, pos, id);
