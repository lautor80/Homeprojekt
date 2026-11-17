-- Rechnungsversand (Funktion transport.versand.rechnung): Rechnungen gehen aus einem festen Absender-Postfach (z. B. der
-- Buchhaltung) und immer mit einer festen BCC-Adresse (z. B. der DATEV-Upload-Adresse) hinaus.
-- Die Werte stehen nur in der Datenbank (Administration → Einstellungen → Euroflex → Mail-Workflows), nie im Repository:
-- Die DATEV-Upload-Adresse ist ein Zugang zum Belegeingang.
alter table transport.workflow_einstellungen add column if not exists rechnung jsonb not null default '{}';
