-- Weltenwandler: Benutzer mit dieser Rolle wechseln ohne neue Anmeldung untereinander (Berechtigungstests).
-- Die Rolle selbst gewährt keine Rechte; nur ein Administrator darf sie ändern.
insert into core.roles (id, name, description, system, nur_admin)
values ('WELTENWANDLER', 'Weltenwandler', 'Ohne neue Anmeldung zu anderen Benutzern mit dieser Rolle wechseln (für Berechtigungstests)', false, true)
on conflict (id) do nothing;
-- Sitzung: mit welchem Benutzer sie angemeldet wurde (für den Rückweg und die Schranke zu Administratoren)
alter table core.sessions add column if not exists ursprung_user_id uuid references core.users(id) on delete cascade;
