-- Rollen, die das Portal selbst vergibt (z. B. bei Registrierung oder Benutzeranlage), aber deren Berechtigungen der Verein
-- pflegt: keine Systemrollen, nur ein Administrator (Rolle ADMIN) darf sie ändern, löschen geht nicht.
alter table core.roles add column if not exists nur_admin boolean not null default false;
comment on column core.roles.nur_admin is 'nur durch Administratoren änderbar, nicht löschbar (vom Portal automatisch vergeben)';
