-- Rundschreiben an Rollen (Berechtigungsgruppen): Empfänger können auch Benutzer ohne Mitgliedschaft sein (z. B. externe
-- Hallennutzer). Je Empfängerzeile stehen sie neben den Mitgliedern (adrnrs) in benutzer_ids – „erneut senden“ schlägt
-- damit die inzwischen berichtigte Adresse nach. Die Auswahl selbst (auswahl.rollen) steht im jsonb-Feld auswahl.
alter table tco.rundschreiben_empfaenger add column if not exists benutzer_ids uuid[] not null default '{}';
