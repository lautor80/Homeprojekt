-- #11 Abo-Bewerbung: Training (Jugend-, Schnuppertraining …) wird über feste Belegungen der Platzverwaltung geblockt und nicht abgefragt –
-- bereits vorgemerkte, noch offene Bestätigungen dafür entfallen.
delete from tco.abo_wunsch where art = 'BESTAETIGUNG' and status = 'OFFEN' and name ilike '%training%';
