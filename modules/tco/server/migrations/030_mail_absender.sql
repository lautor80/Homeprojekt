-- Mailversand über n8n: Absender je Anwendung (z. B. Registrierung → portal@…, Mitgliedsantrag → kassenwart@…).
-- Liste von { anwendung, email, name, antwort_an }; anwendung '*' = Standard. Leer = Standardabsender des n8n-Workflows.
alter table tco.verein add column if not exists mail_absender jsonb not null default '[]';
