-- Hallenschlüssel (#215): Abgleich mit früheren Kontobewegungen der FI-Belege auf zwei wählbaren Konten
-- (leer = Konto des Hallenprodukts 008 bzw. das Kassenkonto).
alter table tco.schluessel_cfg add column if not exists abgleich_konto1 text not null default '';
alter table tco.schluessel_cfg add column if not exists abgleich_konto2 text not null default '';
