-- Rollen zeitraumbezogen deaktivieren (Administration → Rollen): Solange heute im Zeitraum
-- inaktiv_von … inaktiv_bis liegt, gewährt die Rolle keinem Benutzer eine Berechtigung – die Zuordnung
-- zu den Benutzern bleibt erhalten und wirkt nach Ablauf des Zeitraums automatisch wieder.
--   inaktiv_von: erster Tag ohne Wirkung (leer = Rolle nicht deaktiviert)
--   inaktiv_bis: letzter Tag ohne Wirkung (leer = unbefristet deaktiviert)
--   inaktiv_grund: Freitext, z. B. „Winterpause“
-- Die Administratorrolle ist ausgenommen (sonst könnte sich niemand mehr anmelden und es reparieren).
alter table core.roles add column if not exists inaktiv_von   date;
alter table core.roles add column if not exists inaktiv_bis   date;
alter table core.roles add column if not exists inaktiv_grund text;

alter table core.roles drop constraint if exists roles_inaktiv_zeitraum;
alter table core.roles add constraint roles_inaktiv_zeitraum
  check (inaktiv_bis is null or (inaktiv_von is not null and inaktiv_bis >= inaktiv_von));

alter table core.roles drop constraint if exists roles_admin_immer_aktiv;
alter table core.roles add constraint roles_admin_immer_aktiv
  check (id <> 'ADMIN' or (inaktiv_von is null and inaktiv_bis is null));

-- true, wenn die Rolle heute (Zeitzone der Datenbank/des Servers) deaktiviert ist
create or replace function core.rolle_inaktiv(von date, bis date) returns boolean
language sql stable as $$
  select von is not null and current_date >= von and (bis is null or current_date <= bis)
$$;
