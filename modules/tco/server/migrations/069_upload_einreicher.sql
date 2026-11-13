-- Dokumenten-Upload „Überweisung an Einreicher“: der Einreicher als Benutzer, damit der Arbeitsvorrat die Bankverbindung
-- aus dem Mitgliederstamm (tco.mitgliedera.benutzer_id → tco.mitglieder) für Zahlungsdaten und QR-Code findet.
alter table tco.upload_folge add column if not exists benutzer_id uuid references core.users(id) on delete set null;
