-- Gemeinsamer Verbrauch beim Schlüssel „verbrauch“ (Gemeinschaftszähler wie Waschküche/Keller oder Heizungsstrom,
-- Rest des Hauptzählers): Teilung nach Wohnfläche (bisher fest), Personen oder zu gleichen Teilen.
-- Unterzähler können jetzt auch hinter anderen Unterzählern liegen (haupt_id); ohne Wohnung = Gemeinschaftszähler.
alter table miete.kostenarten
  add column if not exists gemeinsam_schluessel text not null default 'flaeche'
    check (gemeinsam_schluessel in ('flaeche', 'personen', 'einheiten'));
