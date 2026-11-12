-- #11 Abo-Bewerbung: Ausnahme „nicht per E-Mail erreichbar“ als erledigt kennzeichnen – wird für diesen Eintrag nicht mehr angezeigt
alter table tco.abo_wunsch add column if not exists mail_ignorieren boolean not null default false;
