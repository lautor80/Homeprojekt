-- Haushaltsstrom (gemeinsam): gemeinsamer Verbrauch nach Anzahl der Personen je Wohnung (Personentage) statt nach Wohnfläche.
-- Gilt auch, wenn keine Zähler bzw. Ablesungen vorliegen. Nur, wo noch die Voreinstellung „flaeche“ steht.
update miete.kostenarten set gemeinsam_schluessel = 'personen'
 where bezeichnung = 'Haushaltsstrom (gemeinsam)' and gemeinsam_schluessel = 'flaeche';
